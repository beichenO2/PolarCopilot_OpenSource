import { useEffect, useCallback, useState, useMemo, useRef, useLayoutEffect } from 'react'
import { useHubStore } from '../stores/hub'
import { AgentCard } from '../components/AgentCard'
import { PromptCard } from '../components/PromptCard'
import { EcoTree } from '../components/EcoTree'
import { TopicsPanel } from '../components/TopicsPanel'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { playNotifySound, unlockAudio, isAudioLocked, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import { useUiSse } from '../lib/useUiSse'
import type { Agent, Prompt } from '../types/hub'

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

  return { saveAnchor, userInteractingRef }
}

const notifiedIds = new Set<string>()
const draftInputs = new Map<string, string>()
const draftHeights = new Map<string, number>()
export function PromptsPage() {
  const { agents, pendingPrompts, historyPrompts, selectedAgentId, fetchAgents, fetchPrompts, fetchHistory, selectAgent, answerPrompt } = useHubStore()
  const [showHistory, setShowHistory] = useState(true)
  const [showDeadAgents, setShowDeadAgents] = useState(false)
  const [audioLocked, setAudioLocked] = useState(true)
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const [ecoTreeRefreshKey, setEcoTreeRefreshKey] = useState(0)

  const handleAnnotationsConsumed = useCallback(() => {
    setEcoTreeRefreshKey(k => k + 1)
  }, [])

  const mainScrollRef = useRef<HTMLDivElement>(null)
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
    fetchAgents().catch(() => {})
    fetchPrompts().catch(() => {})
    if (showHistory) fetchHistory().catch(() => {})
  }, [fetchAgents, fetchPrompts, fetchHistory, showHistory, saveAnchor])

  useUiSse(useCallback(() => { refresh() }, [refresh]))

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 60000)
    return () => clearInterval(iv)
  }, [refresh])

  const { aliveAgents, deadAgents, solos, unassignedSlaves, slavesByParent } = useMemo(() => {
    const alive = agents.filter((a) => a.alive)
    const dead = agents.filter((a) => !a.alive)
    const byParent: Record<string, Agent[]> = {}
    agents.forEach((a) => {
      if (a.agent_type === 'slave' && a.parent_agent_id) {
        ;(byParent[a.parent_agent_id] = byParent[a.parent_agent_id] || []).push(a)
      }
    })
    const assignedIds = new Set(Object.values(byParent).flatMap((arr) => arr.map((s) => s.agent_id)))
    return {
      aliveAgents: alive,
      deadAgents: dead,
      solos: alive.filter((a) => a.agent_type !== 'slave'),
      unassignedSlaves: alive.filter((a) => a.agent_type === 'slave' && !assignedIds.has(a.agent_id)),
      slavesByParent: byParent,
    }
  }, [agents])

  const filteredPrompts = useMemo(() => {
    const list = selectedAgentId
      ? pendingPrompts.filter((p) => p.agent_id === selectedAgentId)
      : pendingPrompts
    return [...list].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
  }, [selectedAgentId, pendingPrompts])

  const filteredHistory = useMemo(() => {
    const list = selectedAgentId
      ? historyPrompts.filter((p) => p.agent_id === selectedAgentId)
      : historyPrompts
    return [...list].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
  }, [selectedAgentId, historyPrompts])

  const handlePurgeDead = async () => {
    await api.agents.purgeDead()
    await fetchAgents()
  }

  const handleDismissPrompt = async (id: string) => {
    await api.prompts.answer(id, '[dismissed by user]')
    await fetchPrompts()
    await fetchHistory()
  }

  const handleDeleteAgent = async (id: string) => {
    await api.agents.remove(id)
    await fetchAgents()
  }

  const handleBatchAssign = async (targetSoloId: string) => {
    for (const sl of unassignedSlaves) {
      await api.agents.update(sl.agent_id, { agent_type: 'slave', parent_agent_id: targetSoloId })
    }
    await fetchAgents()
  }


  return (
    <div className="flex gap-4 -mx-6 -mt-2">
      {/* Left: Tree Panel */}
      <aside className="w-[220px] flex-shrink-0 border-r border-hub-border px-2 py-4 max-h-[calc(100vh-80px)] overflow-y-auto sticky top-0">
          <EcoTree
            refreshKey={ecoTreeRefreshKey}
          />

          {/* Agents: compact footer */}
          <div className="mt-4 pt-3 border-t border-hub-border">
            <div
              onClick={() => setShowAgentPanel(!showAgentPanel)}
              className="flex items-center gap-1.5 cursor-pointer text-hub-text-muted text-[0.65rem] hover:text-hub-text px-2"
            >
              <span>Agents</span>
              {aliveAgents.length > 0 && (
                <span className="bg-hub-accent-bg text-white text-[0.5rem] font-bold px-1.5 py-px rounded-full">
                  {aliveAgents.length}
                </span>
              )}
              <span className={`text-[0.5rem] ml-auto transition-transform ${showAgentPanel ? 'rotate-180' : ''}`}>▼</span>
            </div>

            {showAgentPanel && (
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-between px-2">
                  <span className="text-[0.65rem] text-hub-text-muted">
                    {aliveAgents.length} active{deadAgents.length > 0 && ` · ${deadAgents.length} dead`}
                  </span>
                  <button
                    onClick={handlePurgeDead}
                    className="text-[0.55rem] px-1.5 py-0.5 rounded border border-hub-red/40 text-hub-red hover:bg-hub-red/10 transition-colors"
                  >
                    Purge
                  </button>
                </div>

                {unassignedSlaves.length > 0 && solos.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap text-[0.6rem] px-2">
                    <span className="text-hub-text-muted">{unassignedSlaves.length} free</span>
                    <select
                      id="batch-target"
                      className="px-1 py-0.5 border border-hub-border rounded bg-hub-bg text-hub-text text-[0.6rem]"
                    >
                      {solos.map((s) => (
                        <option key={s.agent_id} value={s.agent_id}>
                          {s.display_name || s.agent_id}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        const sel = (document.getElementById('batch-target') as HTMLSelectElement)?.value
                        if (sel) handleBatchAssign(sel)
                      }}
                      className="px-1 py-0.5 border border-hub-border rounded bg-[#21262d] text-hub-text-muted hover:border-hub-accent text-[0.6rem]"
                    >
                      Assign
                    </button>
                  </div>
                )}

                {solos.map((a) => (
                  <AgentCard
                    key={a.agent_id}
                    agent={a}
                    selected={a.agent_id === selectedAgentId}
                    onClick={() => selectAgent(a.agent_id === selectedAgentId ? null : a.agent_id)}
                    onDelete={handleDeleteAgent}
                    slaves={slavesByParent[a.agent_id]}
                  />
                ))}
                {unassignedSlaves.map((a) => (
                  <AgentCard
                    key={a.agent_id}
                    agent={a}
                    selected={a.agent_id === selectedAgentId}
                    onClick={() => selectAgent(a.agent_id === selectedAgentId ? null : a.agent_id)}
                    onDelete={handleDeleteAgent}
                  />
                ))}
                {showDeadAgents && deadAgents.map((a) => (
                  <div key={a.agent_id} className="opacity-50">
                    <AgentCard
                      agent={a}
                      selected={a.agent_id === selectedAgentId}
                      onClick={() => selectAgent(a.agent_id === selectedAgentId ? null : a.agent_id)}
                      onDelete={handleDeleteAgent}
                    />
                  </div>
                ))}
                {deadAgents.length > 0 && (
                  <button
                    onClick={() => setShowDeadAgents(!showDeadAgents)}
                    className="text-[0.6rem] text-hub-text-muted hover:text-hub-text w-full text-center"
                  >
                    {showDeadAgents ? 'Hide' : 'Show'} {deadAgents.length} dead
                  </button>
                )}
                {aliveAgents.length === 0 && (
                  <p className="text-[0.65rem] text-hub-text-muted italic text-center py-2">
                    No active agents
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Topics: draggable to Pending cards */}
          <TopicsPanel mode="reference" />
        </aside>

      {/* Center: Pending Prompts */}
      <main ref={mainScrollRef} className="flex-1 min-w-0 py-4">
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
              Pending
              <span className="text-[0.7rem] px-2 py-0.5 rounded-lg bg-hub-accent-bg text-white">
                {filteredPrompts.length}
              </span>
            </h2>
          </div>

          <div className="space-y-4">
            {filteredPrompts.map((p) => (
              <div key={p.id} id={`prompt-${p.id}`}>
                <PromptCard
                  prompt={p}
                  onAnswer={answerPrompt}
                  onDismiss={handleDismissPrompt}
                  savedDraft={draftInputs.get(p.id) ?? ''}
                  savedHeight={draftHeights.get(p.id)}
                  onDraftChange={(text) => { if (text) draftInputs.set(p.id, text); else draftInputs.delete(p.id) }}
                  onHeightChange={(h) => { if (h) draftHeights.set(p.id, h); else draftHeights.delete(p.id) }}
                  onAnnotationsConsumed={handleAnnotationsConsumed}
                />
              </div>
            ))}
            {filteredPrompts.length === 0 && (
              <p className="text-sm text-hub-text-muted italic text-center py-8">
                No pending questions. Agents will post here when they need input.
              </p>
            )}
          </div>
        </section>
      </main>

      {/* Right: History Sidebar */}
      <aside className="w-[320px] flex-shrink-0 border-l border-hub-border px-3 py-4 max-h-[calc(100vh-80px)] overflow-y-auto sticky top-0">
        <div className="flex items-center gap-3 mb-3 pb-2 border-b border-hub-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            History
            <span className="text-[0.65rem] px-1.5 py-0.5 rounded-lg bg-hub-border text-hub-text-muted">
              {filteredHistory.length}
            </span>
          </h2>
          <button
            onClick={() => { setShowHistory(!showHistory); if (!showHistory) fetchHistory() }}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md border border-hub-border text-hub-text-muted text-[0.65rem] hover:border-hub-accent hover:text-hub-text transition-colors select-none"
          >
            <span className={`inline-block transition-transform ${showHistory ? 'rotate-180' : ''}`}>▼</span>
            {showHistory ? ' Hide' : ' Show'}
          </button>
        </div>

        {showHistory && (
          <div className="space-y-2">
            {filteredHistory.map((p) => (
              <HistoryCard key={p.id} prompt={p} />
            ))}
            {filteredHistory.length === 0 && (
              <p className="text-[0.75rem] text-hub-text-muted italic text-center py-4">No history yet</p>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}

/* ---- History Card ---- */

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
