import { useEffect, useCallback, useState, useMemo, useRef, useLayoutEffect } from 'react'
import { clsx } from 'clsx'
import { useHubStore } from '../stores/hub'
import { AgentCard } from '../components/AgentCard'
import { PromptCard } from '../components/PromptCard'
import { EcoTree } from '../components/EcoTree'
import { TopicsPanel } from '../components/TopicsPanel'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { buildCenterThread, isAtLiveEdge, pendingScrollTargetId, shouldRenderAgentBubble } from '../lib/prompt-thread'
import type { ThreadMessage } from '../lib/prompt-thread'
import { playNotifySound, unlockAudio, isAudioLocked, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import { useUiSse } from '../lib/useUiSse'
import { useResizableWidth } from '../lib/useResizableWidth'
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
  const [showDeadAgents, setShowDeadAgents] = useState(false)
  const [audioLocked, setAudioLocked] = useState(true)
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const [ecoTreeRefreshKey, setEcoTreeRefreshKey] = useState(0)

  const handleAnnotationsConsumed = useCallback(() => {
    setEcoTreeRefreshKey(k => k + 1)
  }, [])

  const mainScrollRef = useRef<HTMLDivElement>(null)
  const pendingSectionRef = useRef<HTMLDivElement>(null)

  const { saveAnchor, userInteractingRef } = useScrollAnchor(pendingSectionRef, [pendingPrompts, historyPrompts, selectedAgentId])
  const threadEndRef = useRef<HTMLDivElement>(null)
  const prevPendingIdsRef = useRef<Set<string>>(new Set())
  const didInitialScrollRef = useRef(false)
  const hasUserScrolledRef = useRef(false)

  useEffect(() => {
    const markUserScrolled = () => {
      hasUserScrolledRef.current = true
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
        markUserScrolled()
      }
    }
    const opts: AddEventListenerOptions = { passive: true }
    window.addEventListener('wheel', markUserScrolled, opts)
    window.addEventListener('touchmove', markUserScrolled, opts)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('wheel', markUserScrolled, opts)
      window.removeEventListener('touchmove', markUserScrolled, opts)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const readScrollBottomGapPx = useCallback((): number => {
    const container = mainScrollRef.current
    if (container && container.scrollHeight > container.clientHeight) {
      return container.scrollHeight - container.scrollTop - container.clientHeight
    }
    return document.documentElement.scrollHeight - window.scrollY - window.innerHeight
  }, [])

  // 左侧栏拖拽调宽（localStorage 持久化，双击分隔条重置）
  const leftPane = useResizableWidth('pc-prompts-left-w', 220, 160, 520)

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
    fetchHistory().catch(() => {})
  }, [fetchAgents, fetchPrompts, fetchHistory, saveAnchor])

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

  const centerThread = useMemo(
    () => buildCenterThread(selectedAgentId, pendingPrompts, historyPrompts),
    [selectedAgentId, pendingPrompts, historyPrompts],
  )

  const promptById = useMemo(() => {
    const map = new Map<string, Prompt>()
    for (const p of historyPrompts) map.set(p.id, p)
    for (const p of pendingPrompts) map.set(p.id, p)
    return map
  }, [pendingPrompts, historyPrompts])

  const pendingCount = useMemo(
    () => centerThread.messages.filter((m) => m.role === 'pending').length,
    [centerThread],
  )
  useLayoutEffect(() => {
    if (!mainScrollRef.current) return

    const currentPendingIds = new Set(pendingPrompts.map((p) => p.id))
    const prevPendingIds = prevPendingIdsRef.current
    const hasNewPending = [...currentPendingIds].some((id) => !prevPendingIds.has(id))
    const atLiveEdge = isAtLiveEdge(readScrollBottomGapPx())
    const shouldScroll =
      (!hasUserScrolledRef.current && !didInitialScrollRef.current) ||
      (hasNewPending && atLiveEdge)

    if (shouldScroll) {
      const targetId = pendingScrollTargetId(centerThread.messages)
      const pendingEl = targetId ? document.getElementById(`prompt-${targetId}`) : null
      const behavior = didInitialScrollRef.current ? 'smooth' : 'auto'
      if (pendingEl) {
        pendingEl.scrollIntoView({ block: 'end', behavior })
      } else {
        threadEndRef.current?.scrollIntoView({ block: 'end', behavior })
      }
      didInitialScrollRef.current = true
    }

    prevPendingIdsRef.current = currentPendingIds
  }, [centerThread, pendingPrompts, readScrollBottomGapPx])

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
    <div className="flex -mx-6 -mt-2">
      {/* Left: Tree Panel */}
      <aside
        style={{ width: leftPane.width }}
        className="flex-shrink-0 px-2 py-4 max-h-[calc(100vh-80px)] overflow-y-auto sticky top-0"
      >
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
          <TopicsPanel mode="reference" agentId={selectedAgentId} />
        </aside>

      <ResizeHandle onMouseDown={leftPane.onMouseDown} onDoubleClick={leftPane.reset} dragging={leftPane.dragging} />

      {/* Center: Thread */}
      <main ref={mainScrollRef} className="flex-1 min-w-0 py-4 px-4">
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
              Thread
              {pendingCount > 0 && (
                <span className="text-[0.7rem] px-2 py-0.5 rounded-lg bg-hub-accent-bg text-white">
                  {pendingCount} pending
                </span>
              )}
            </h2>
          </div>

          <div className="space-y-4">
            {centerThread.messages.map((msg) => {
              if (msg.role === 'pending') {
                const p = promptById.get(msg.prompt_id)
                if (!p) return null
                return (
                  <div key={msg.id} id={`prompt-${p.id}`}>
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
                )
              }
              if (msg.role === 'agent') {
                if (!shouldRenderAgentBubble(centerThread.messages, msg)) return null
                const p = promptById.get(msg.prompt_id)
                return (
                  <ThreadAgentBubble
                    key={msg.id}
                    message={msg}
                    agentLabel={!selectedAgentId ? (p?.display_name || p?.agent_id || undefined) : undefined}
                  />
                )
              }
              return <ThreadUserBubble key={msg.id} message={msg} />
            })}
            {centerThread.messages.length === 0 && (
              <p className="text-sm text-hub-text-muted italic text-center py-8">
                No messages yet. Agent questions and your replies will appear here in order.
              </p>
            )}
            <div ref={threadEndRef} aria-hidden="true" />
          </div>
        </section>
      </main>
    </div>
  )
}

/* ---- Thread Bubbles ---- */

function ThreadAgentBubble({ message, agentLabel }: { message: ThreadMessage; agentLabel?: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] bg-hub-surface border border-[#21262d] rounded-[10px] px-[18px] py-3.5">
        {agentLabel && (
          <div className="text-[0.65rem] text-hub-text-muted mb-1.5">{agentLabel}</div>
        )}
        <div
          className="text-[0.9rem] leading-relaxed text-hub-text markdown-body select-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }}
        />
        {message.attachments.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <a
                key={a.href}
                href={a.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[0.75rem] text-hub-accent hover:underline"
              >
                {a.title ?? a.href}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ThreadUserBubble({ message }: { message: ThreadMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-[#21262d] border border-hub-border rounded-[10px] px-[18px] py-3.5">
        <div className="text-[0.85rem] text-hub-green font-medium whitespace-pre-wrap break-words select-text">
          {message.text || '(no answer)'}
        </div>
      </div>
    </div>
  )
}

/* ---- Resize Handle（侧栏拖拽分隔条）---- */

function ResizeHandle({ onMouseDown, onDoubleClick, dragging }: {
  onMouseDown: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  dragging: boolean
}) {
  return (
    <div
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
      title="拖拽调宽 · 双击重置"
      className={clsx(
        'w-[5px] flex-shrink-0 cursor-col-resize self-stretch relative group transition-colors',
        dragging ? 'bg-hub-accent' : 'bg-hub-border hover:bg-hub-accent/60',
      )}
    >
      {/* 扩大热区 */}
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className={clsx(
        'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full transition-opacity',
        dragging ? 'bg-hub-accent opacity-100' : 'bg-hub-text-muted/40 opacity-0 group-hover:opacity-100',
      )} />
    </div>
  )
}
