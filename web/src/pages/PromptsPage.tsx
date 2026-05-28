import { useEffect, useCallback, useState, useMemo, useRef, useLayoutEffect } from 'react'
import { useHubStore } from '../stores/hub'
import { PromptCard } from '../components/PromptCard'
import { ResizableSplitPane } from '../components/ResizableSplitPane'
import { HistoryPanel } from '../components/HistoryPanel'
import { renderMarkdown } from '../lib/markdown'
import { playNotifySound, unlockAudio, isAudioLocked, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import { useUiSse } from '../lib/useUiSse'
import type { Prompt } from '../types/hub'

function useScrollAnchor(anchorContainerRef: React.RefObject<HTMLElement | null>, deps: unknown[]) {
  const anchorRef = useRef<{ id: string; top: number } | null>(null)
  const userInteractingRef = useRef(false)

  useEffect(() => {
    const onDown = () => { userInteractingRef.current = true }
    const onUp = () => { userInteractingRef.current = false }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('mouseup', onUp, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('mouseup', onUp, true)
    }
  }, [])

  const saveAnchor = useCallback(() => {
    const container = anchorContainerRef.current
    if (!container) return
    const active = document.activeElement
    const hasFocused = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && container.contains(active)
    const isAnnotating = !!container.querySelector('.pc-annotation-popover')
    if (!userInteractingRef.current && !hasFocused && !isAnnotating) return
    const cards = container.querySelectorAll<HTMLElement>('[id^="prompt-"]')
    for (const card of cards) {
      const rect = card.getBoundingClientRect()
      if (rect.top >= -100 && rect.top <= window.innerHeight) {
        anchorRef.current = { id: card.id, top: rect.top }
        return
      }
    }
  }, [anchorContainerRef])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const el = document.getElementById(anchor.id)
    if (!el) { anchorRef.current = null; return }
    const delta = el.getBoundingClientRect().top - anchor.top
    if (Math.abs(delta) > 1) window.scrollBy(0, delta)
    anchorRef.current = null
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps

  return { saveAnchor }
}

const notifiedIds = new Set<string>()
const draftInputs = new Map<string, string>()
const draftHeights = new Map<string, number>()

export function PromptsPage() {
  const { pendingPrompts, historyPrompts, fetchPrompts, fetchHistory, answerPrompt } = useHubStore()
  const [showHistory, setShowHistory] = useState(true)
  const [audioLocked, setAudioLocked] = useState(true)

  const pendingSectionRef = useRef<HTMLDivElement>(null)
  const { saveAnchor } = useScrollAnchor(pendingSectionRef, [pendingPrompts, historyPrompts])

  useEffect(() => {
    requestNotificationPermission()
    setAudioLocked(isAudioLocked())
  }, [])

  useEffect(() => {
    let hasNew = false
    for (const p of pendingPrompts) {
      if (!notifiedIds.has(p.id)) {
        notifiedIds.add(p.id)
        hasNew = true
        showDesktopNotification('Agent needs input', p.prompt.slice(0, 100), p.id)
      }
    }
    if (hasNew) playNotifySound()
  }, [pendingPrompts])

  const handleUnlockAudio = () => {
    unlockAudio()
    setTimeout(() => setAudioLocked(isAudioLocked()), 200)
  }

  const refresh = useCallback(() => {
    saveAnchor()
    fetchPrompts().catch(() => {})
    if (showHistory) fetchHistory().catch(() => {})
  }, [fetchPrompts, fetchHistory, showHistory, saveAnchor])

  useUiSse(useCallback(() => { refresh() }, [refresh]))

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 60000)
    return () => clearInterval(iv)
  }, [refresh])

  const sortedPending = useMemo(
    () => [...pendingPrompts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [pendingPrompts],
  )

  const sortedHistory = useMemo(
    () => [...historyPrompts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
    [historyPrompts],
  )

  const handleDismissPrompt = async (id: string) => {
    await answerPrompt(id, '[dismissed by user]')
  }

  const pendingMain = (
    <main className="flex-1 min-w-0 py-4 px-2">
      {audioLocked && (
        <div
          onClick={handleUnlockAudio}
          className="bg-[#1f2937] border border-[#f59e0b] rounded-lg px-4 py-2 text-center text-[#f59e0b] text-sm cursor-pointer hover:bg-[#2a3544] transition-colors mb-4"
        >
          Click to enable notification sounds
        </div>
      )}

      <section ref={pendingSectionRef}>
        <div className="flex items-center gap-3 mb-3 pb-2 border-b border-hub-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            待回答
            <span className="text-[0.7rem] px-2 py-0.5 rounded-lg bg-hub-accent-bg text-white">
              {sortedPending.length}
            </span>
          </h2>
        </div>

        <div className="space-y-4">
          {sortedPending.map((p) => (
            <div key={p.id} id={`prompt-${p.id}`}>
              <PromptCard
                prompt={p}
                onAnswer={answerPrompt}
                onDismiss={handleDismissPrompt}
                savedDraft={draftInputs.get(p.id) ?? ''}
                savedHeight={draftHeights.get(p.id)}
                onDraftChange={(text) => { if (text) draftInputs.set(p.id, text); else draftInputs.delete(p.id) }}
                onHeightChange={(h) => { if (h) draftHeights.set(p.id, h); else draftHeights.delete(p.id) }}
              />
            </div>
          ))}
          {sortedPending.length === 0 && (
            <p className="text-sm text-hub-text-muted italic text-center py-8">
              暂无待回答问题。Agent 通过 MCP 发送 prompt 后会显示在这里；名称见每条卡片上的标签。
            </p>
          )}
        </div>
      </section>
    </main>
  )

  const historyAside = (
    <HistoryPanel
      count={sortedHistory.length}
      show={showHistory}
      onToggleShow={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistory() }}
      storageKey="pc-prompts-history-ratio"
    >
      {sortedHistory.map((p) => (
        <HistoryCard key={p.id} prompt={p} />
      ))}
    </HistoryPanel>
  )

  return (
    <div className="-mx-6 -mt-2 h-[calc(100vh-80px)]">
      <ResizableSplitPane
        left={pendingMain}
        right={historyAside}
        defaultRatio={0.72}
        minLeftPx={360}
        minRightPx={200}
        storageKey="pc-prompts-history-ratio"
        paneLabel="History"
        className="h-full"
      />
    </div>
  )
}

function HistoryCard({ prompt }: { prompt: Prompt }) {
  const [open, setOpen] = useState(false)
  const agentLabel = prompt.display_name || prompt.agent_id || 'system'
  const isInfo = prompt.type === 'info'
  const firstLine = (prompt.prompt.split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, 100)
  const answerPreview = (prompt.answer || '').slice(0, 60)

  return (
    <div className="bg-hub-surface border border-[#21262d] rounded-[10px] px-[18px] py-3.5 opacity-70 hover:opacity-90 transition-opacity">
      <div
        className="flex items-center gap-2.5 cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        {!open && (
          <span className="text-[0.85rem] text-hub-text overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
            {firstLine}
          </span>
        )}
        {open && <span className="flex-1" />}
        <div className="flex items-center gap-3 flex-shrink-0 text-[0.7rem] text-[#484f58] flex-wrap">
          <span>{new Date(prompt.created_at).toLocaleTimeString()}</span>
          <span>{agentLabel}</span>
          {isInfo
            ? <span className="text-hub-accent">info report</span>
            : answerPreview && <span className="text-hub-green font-medium">{answerPreview}{(prompt.answer || '').length > 60 ? '...' : ''}</span>
          }
        </div>
        <span className={`text-[0.7rem] text-[#484f58] flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
      </div>

      {open && (
        <div className="mt-2.5 pt-2.5 border-t border-[#21262d] select-text">
          <div
            className="text-[0.9rem] leading-relaxed text-hub-text markdown-body mb-3"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.prompt) }}
          />
          <div className="mt-2 pt-2 border-t border-[#21262d]">
            <span className="text-[0.7rem] text-[#484f58]">Answer: </span>
            {isInfo
              ? <span className="text-[0.7rem] text-hub-accent">info report</span>
              : <span className="text-[0.85rem] text-hub-green font-medium whitespace-pre-wrap break-words">{prompt.answer || '(no answer)'}</span>
            }
          </div>
        </div>
      )}
    </div>
  )
}
