import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { playNotifySound, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import {
  buildXjSessionFamilyRequest,
  buildXjLaunchPrompt,
  DEFAULT_XJ_AGENT_NAME,
  DEFAULT_XJ_AGENT_ROLE,
  getXjAgentFamily,
  getXjTaskTargetId,
  shouldNotifyXj,
  statusLabel,
  statusTone,
} from '../lib/xj'
import { useResizableWidth } from '../lib/useResizableWidth'
import type { XjMessage, XjSession, XjSessionDetail, XjSkill } from '../types/xj'

const seenAssistantMessages = new Set<string>()
const hydratedSessions = new Set<string>()
const MODE_CARDS = [
  {
    key: 'AI 破甲（道德经Max）',
    title: '安全研究',
    description: '按授权范围路由逆向、CTF、安全评估与证据化交付。',
    accent: 'border-orange-400/35 bg-orange-400/[0.06]',
  },
  {
    key: '夜晚自动化挂机任务',
    title: '夜晚挂机',
    description: '冻结验收标准，执行、验证、反思并在循环上限内继续。',
    accent: 'border-cyan-400/35 bg-cyan-400/[0.06]',
  },
]

export function XjPage() {
  const [sessions, setSessions] = useState<XjSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<XjSessionDetail | null>(null)
  const [skills, setSkills] = useState<XjSkill[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const leftPane = useResizableWidth('pc-xj-left-w', 252, 190, 480)
  const rightPane = useResizableWidth('pc-xj-right-w', 336, 260, 560, true)

  const refreshSessions = useCallback(async () => {
    const result = await api.xj.sessions()
    setSessions(result.sessions)
    setSelectedId((current) => current && result.sessions.some((s) => s.id === current)
      ? current
      : result.sessions.find((session) => !session.parentSessionId)?.id ?? result.sessions[0]?.id ?? null)
  }, [])

  const refreshDetail = useCallback(async (id: string) => {
    const next = await api.xj.detail(id)
    setDetail(next)
    const firstLoad = !hydratedSessions.has(id)
    for (const message of next.history) {
      if (!firstLoad && shouldNotifyXj(message, seenAssistantMessages)) {
        showDesktopNotification(`XJ · ${next.session.title}`, message.content, message.id)
        playNotifySound()
      }
      if (message.role === 'assistant') seenAssistantMessages.add(message.id)
    }
    hydratedSessions.add(id)
  }, [])

  const refresh = useCallback(async () => {
    try {
      await refreshSessions()
      if (selectedId) await refreshDetail(selectedId)
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [refreshSessions, refreshDetail, selectedId])

  useEffect(() => {
    requestNotificationPermission()
    void api.xj.skills().then((result) => setSkills(result.skills)).catch(() => {})
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId)
    else setDetail(null)
  }, [selectedId, refreshDetail])

  useEffect(() => {
    const es = new EventSource('/api/ui/xj/stream')
    const onEvent = () => void refresh()
    for (const event of ['xj_session_updated', 'xj_session_removed', 'xj_message_created', 'xj_automation_updated', 'xj_store_changed']) {
      es.addEventListener(event, onEvent)
    }
    const fallback = window.setInterval(() => void refresh(), 15_000)
    return () => { es.close(); window.clearInterval(fallback) }
  }, [refresh])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [detail?.history.length])

  const createSession = async () => {
    setBusy(true)
    try {
      const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
      const launchId = `xjlaunch-${Date.now()}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
      const result = await api.xj.createSession(buildXjSessionFamilyRequest(launchId, `XJ · ${stamp}`))
      await refreshSessions()
      setSelectedId(result.session.id)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const submitMessage = async (rawContent: string) => {
    if (!selectedId || !rawContent.trim() || busy) return
    const content = rawContent.trim()
    if (content === draft.trim()) setDraft('')
    setBusy(true)
    try {
      const targetId = getXjTaskTargetId(sessions, selectedId)
      await api.xj.send(targetId, content)
      setSelectedId(targetId)
      await refreshDetail(targetId)
      await refreshSessions()
    } catch (e) { setDraft(content); setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const copyLaunchPrompt = async (session: XjSession) => {
    if (!session.launchId) return
    try {
      const prompt = buildXjLaunchPrompt({
        launchId: session.launchId,
        name: session.name || DEFAULT_XJ_AGENT_NAME,
        role: session.role || DEFAULT_XJ_AGENT_ROLE,
        modes: session.modes,
        agentSlot: session.agentSlot,
        parentSessionId: session.parentSessionId,
      })
      await navigator.clipboard.writeText(prompt)
      setError('')
      setCopiedSessionId(session.id)
      window.setTimeout(() => setCopiedSessionId((current) => current === session.id ? null : current), 1800)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const toggleMode = async (key: string) => {
    if (!detail) return
    const modes = detail.session.modes.includes(key)
      ? detail.session.modes.filter((mode) => mode !== key)
      : [...detail.session.modes, key]
    await api.xj.setModes(detail.session.id, modes)
    await refreshDetail(detail.session.id)
  }

  const saveAutomation = async (patch: Parameters<typeof api.xj.setAutomation>[1]) => {
    if (!detail) return
    await api.xj.setAutomation(detail.session.id, patch)
    await refreshDetail(detail.session.id)
  }

  const activeSkills = useMemo(() => {
    if (!detail) return []
    return skills.filter((skill) => detail.session.modes.includes(skill.bundle) || detail.session.modes.includes(skill.name))
  }, [detail, skills])
  const rootSessions = useMemo(() => sessions.filter((session) => !session.parentSessionId), [sessions])
  const agentFamily = useMemo(
    () => selectedId ? getXjAgentFamily(sessions, selectedId) : null,
    [sessions, selectedId],
  )

  return (
    <div className="xj-shell flex -mx-6 -my-6 h-[calc(100vh-73px)] overflow-hidden">
      <aside style={{ width: leftPane.width }} className="xj-sidebar flex-shrink-0 flex flex-col border-r border-hub-border bg-[#0b1016]">
        <div className="px-4 py-4 border-b border-hub-border">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-[0.24em] text-cyan-300/70">Persistent MCP</div>
              <h2 className="text-base font-semibold text-hub-text mt-1">XJ 会话</h2>
            </div>
            <button onClick={() => void createSession()} disabled={busy} className="w-8 h-8 rounded-lg border border-hub-accent/50 text-hub-accent hover:bg-hub-accent/10 disabled:opacity-50" title="新建 1 主 + 2 子 Agent 编队">＋</button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {rootSessions.map((session) => {
            const children = sessions
              .filter((candidate) => candidate.parentSessionId === session.id)
              .sort((a, b) => (a.agentSlot ?? '').localeCompare(b.agentSlot ?? ''))
            return <div key={session.id} className="space-y-1">
              <SessionNavButton session={session} selected={selectedId === session.id} label="MAIN" onSelect={setSelectedId} />
              {children.length > 0 && <div className="ml-4 border-l border-cyan-400/15 pl-2 space-y-1">
                {children.map((child, index) => (
                  <SessionNavButton key={child.id} session={child} selected={selectedId === child.id} label={`SUB 0${index + 1}`} compact onSelect={setSelectedId} />
                ))}
              </div>}
            </div>
          })}
          {sessions.length === 0 && <div className="text-xs text-hub-text-muted text-center py-12 px-5 leading-6">点击右上角「＋」，自动生成一个普通主 Agent 和两个专属子 Agent。</div>}
        </div>
        <div className="p-3 border-t border-hub-border text-[10px] text-hub-text-muted leading-5">
          本地文件队列 · 24h 重连窗口<br />独立 stdio MCP · 无远端授权依赖
        </div>
      </aside>

      <ResizeHandle pane={leftPane} />

      <main className="flex-1 min-w-0 flex flex-col bg-hub-bg">
        {detail ? (
          <>
            <header className="px-5 py-3 border-b border-hub-border bg-hub-surface/40 flex items-center gap-3">
              <div className="min-w-0">
                <h1 className="text-sm font-semibold truncate">{detail.session.title}</h1>
                <div className="text-[10px] text-hub-text-muted font-mono mt-0.5 truncate">{detail.session.launchId || detail.session.id}</div>
              </div>
              <span className={clsx('ml-auto text-[10px] px-2.5 py-1 rounded-full border', statusTone(detail.session.status))}>{statusLabel(detail.session.status)}</span>
              <button
                onClick={() => void copyLaunchPrompt(detail.session)}
                disabled={!detail.session.launchId}
                className="text-[10px] px-3 py-1.5 border border-cyan-400/40 rounded-md text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40 disabled:border-hub-border disabled:text-hub-text-muted"
                title={detail.session.launchId ? '复制后粘贴到 Cursor Agent，即可接入该持续会话' : '旧版会话没有 launchId'}
              >{copiedSessionId === detail.session.id ? '已复制启动 Prompt' : '复制启动 Prompt'}</button>
            </header>

            <div ref={transcriptRef} className="flex-1 overflow-y-auto px-5 py-5">
              <div className="max-w-4xl mx-auto space-y-4">
                {detail.history.map((message) => <MessageBubble key={message.id} message={message} onSuggestion={(suggestion) => void submitMessage(suggestion)} />)}
                {detail.history.length === 0 && (
                  <div className="border border-dashed border-hub-border rounded-2xl p-10 text-center">
                    <div className="text-2xl mb-3">∞</div>
                    <p className="text-sm text-hub-text">Agent 编队令牌已生成</p>
                    <p className="text-xs text-hub-text-muted mt-2">右侧可分别复制主 Agent 与两个子 Agent 的启动 Prompt；三者接入后即可持续协作。</p>
                  </div>
                )}
              </div>
            </div>

            <div className="border-t border-hub-border bg-[#0b1016] px-5 py-4">
              {error && <div className="max-w-4xl mx-auto mb-2 text-xs text-hub-red">{error}</div>}
              <div className="max-w-4xl mx-auto rounded-xl border border-hub-border bg-hub-surface overflow-hidden focus-within:border-hub-accent/70">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submitMessage(draft) }
                }} placeholder="输入一次完整任务，主 Agent 会持续执行到交付…（⌘+Enter）" className="w-full min-h-[88px] max-h-56 resize-y bg-transparent px-4 py-3 text-sm outline-none placeholder:text-hub-text-muted/60" />
                <div className="flex items-center px-3 py-2 border-t border-hub-border/70">
                  <span className="text-[10px] text-hub-text-muted">单次输入直达完成 · 1 主 + 2 子 · 自动技能路由</span>
                  <button onClick={() => void submitMessage(draft)} disabled={!draft.trim() || busy} className="ml-auto px-4 py-1.5 rounded-lg bg-hub-accent-bg text-white text-xs font-medium disabled:opacity-40">发送</button>
                </div>
              </div>
            </div>
          </>
        ) : <div className="flex-1 grid place-items-center text-sm text-hub-text-muted">选择或创建一个 XJ 会话</div>}
      </main>

      <ResizeHandle pane={rightPane} />

      <aside style={{ width: rightPane.width }} className="flex-shrink-0 overflow-y-auto border-l border-hub-border bg-[#0b1016] p-4 space-y-4">
        {detail && (
          <>
            {agentFamily && <AgentFamilyPanel
              main={agentFamily.main}
              subagents={agentFamily.subagents}
              selectedId={detail.session.id}
              copiedSessionId={copiedSessionId}
              onSelect={setSelectedId}
              onCopy={copyLaunchPrompt}
            />}
            <ProgressPanel detail={detail} />
            <section>
              <SectionTitle title="模式路由" suffix={`${activeSkills.length} active`} />
              <div className="space-y-2">
                {MODE_CARDS.map((mode) => {
                  const enabled = detail.session.modes.includes(mode.key)
                  return <button key={mode.key} onClick={() => void toggleMode(mode.key)} className={clsx('w-full text-left p-3 rounded-xl border transition-all', enabled ? mode.accent : 'border-hub-border bg-hub-surface/40 hover:border-hub-text-muted/50')}>
                    <div className="flex items-center gap-2">
                      <span className={clsx('w-8 h-4 rounded-full p-0.5 transition-colors', enabled ? 'bg-hub-accent' : 'bg-hub-border')}><span className={clsx('block w-3 h-3 rounded-full bg-white transition-transform', enabled && 'translate-x-4')} /></span>
                      <strong className="text-xs">{mode.title}</strong>
                    </div>
                    <p className="text-[10px] leading-5 text-hub-text-muted mt-2">{mode.description}</p>
                  </button>
                })}
              </div>
            </section>
            <AutomationPanel detail={detail} onSave={saveAutomation} onRefresh={() => refreshDetail(detail.session.id)} />
            <section>
              <SectionTitle title="技能目录" suffix={`${skills.length}`} />
              <div className="max-h-52 overflow-y-auto space-y-1">
                {skills.map((skill) => <div key={skill.path} className={clsx('px-2.5 py-2 rounded-lg text-[10px]', activeSkills.some((active) => active.path === skill.path) ? 'bg-hub-accent/10 text-hub-accent' : 'text-hub-text-muted')} title={skill.path}>{skill.bundle}</div>)}
              </div>
            </section>
          </>
        )}
      </aside>
    </div>
  )
}

function statusDot(status: XjSession['status']): string {
  if (status === 'pending') return 'bg-hub-yellow animate-pulse'
  if (status === 'waiting') return 'bg-cyan-300'
  if (status === 'working') return 'bg-hub-accent'
  if (status === 'online') return 'bg-hub-green'
  if (status === 'connecting') return 'bg-cyan-500 animate-pulse'
  return 'bg-hub-text-muted'
}

function SessionNavButton({
  session,
  selected,
  label,
  compact = false,
  onSelect,
}: {
  session: XjSession
  selected: boolean
  label: string
  compact?: boolean
  onSelect: (id: string) => void
}) {
  return <button onClick={() => onSelect(session.id)} className={clsx(
    'w-full text-left rounded-xl border transition-all',
    compact ? 'px-2.5 py-2' : 'px-3 py-3',
    selected ? 'border-hub-accent/60 bg-hub-accent/[0.08]' : 'border-transparent hover:border-hub-border hover:bg-hub-surface/60',
  )}>
    <div className="flex items-center gap-2">
      <span className={clsx('w-2 h-2 rounded-full shrink-0', statusDot(session.status))} />
      <span className={clsx('font-mono tracking-[0.12em] text-cyan-300/60', compact ? 'text-[8px]' : 'text-[9px]')}>{label}</span>
      <span className={clsx('font-medium truncate flex-1', compact ? 'text-xs' : 'text-sm')}>{compact ? (session.name || session.title) : session.title}</span>
      {session.pendingCount > 0 && <span className="text-[10px] rounded-full bg-hub-yellow text-black font-bold px-1.5">{session.pendingCount}</span>}
    </div>
    <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-hub-text-muted">
      <span className="font-mono truncate">{session.id}</span>
      <span className="shrink-0">{statusLabel(session.status)}</span>
    </div>
  </button>
}

function AgentFamilyPanel({
  main,
  subagents,
  selectedId,
  copiedSessionId,
  onSelect,
  onCopy,
}: {
  main: XjSession
  subagents: XjSession[]
  selectedId: string
  copiedSessionId: string | null
  onSelect: (id: string) => void
  onCopy: (session: XjSession) => Promise<void>
}) {
  const agents = [main, ...subagents]
  return <section>
    <SectionTitle title="Agent 编队" suffix={`1 MAIN · ${subagents.length} SUB`} />
    <div className="relative overflow-hidden rounded-xl border border-cyan-400/20 bg-[linear-gradient(145deg,rgba(8,18,26,.96),rgba(12,15,22,.92))] p-2.5">
      <div className="pointer-events-none absolute inset-y-0 left-[22px] w-px bg-gradient-to-b from-cyan-300/40 via-cyan-400/15 to-transparent" />
      <div className="space-y-2">
        {agents.map((session, index) => {
          const isMain = index === 0
          const selected = selectedId === session.id
          const copyReady = Boolean(session.launchId)
          return <div key={session.id} className={clsx(
            'relative rounded-lg border px-2.5 py-2 transition-colors',
            selected ? 'border-cyan-300/45 bg-cyan-300/[0.07]' : 'border-white/[0.06] bg-black/10 hover:border-white/15',
          )}>
            <div className="flex items-center gap-2">
              <span className={clsx('relative z-10 grid h-5 w-5 shrink-0 place-items-center rounded-md border font-mono text-[8px]', isMain ? 'border-cyan-300/40 bg-cyan-300/10 text-cyan-200' : 'border-hub-accent/35 bg-hub-accent/10 text-hub-accent')}>{isMain ? 'M' : `0${index}`}</span>
              <button onClick={() => onSelect(session.id)} className="min-w-0 flex-1 text-left">
                <div className="flex items-center gap-1.5">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', statusDot(session.status))} />
                  <strong className="truncate text-[11px] font-medium text-hub-text">{session.name || (isMain ? DEFAULT_XJ_AGENT_NAME : `子 Agent ${index}`)}</strong>
                </div>
                <div className="mt-1 truncate font-mono text-[8px] text-hub-text-muted">{session.id}</div>
              </button>
              <button
                onClick={() => void onCopy(session)}
                disabled={!copyReady}
                className="shrink-0 rounded-md border border-cyan-400/25 px-2 py-1 text-[9px] text-cyan-300 transition-colors hover:bg-cyan-400/10 disabled:opacity-30"
              >{copiedSessionId === session.id ? '已复制' : '复制 Prompt'}</button>
            </div>
          </div>
        })}
      </div>
    </div>
  </section>
}

function MessageBubble({ message, onSuggestion }: { message: XjMessage; onSuggestion: (suggestion: string) => void }) {
  if (message.role === 'progress') {
    return <div className="mx-auto max-w-2xl flex items-center gap-2 text-[10px] text-hub-text-muted"><div className="h-px bg-hub-border flex-1" /><span>进度 · {message.content}</span><div className="h-px bg-hub-border flex-1" /></div>
  }
  const assistant = message.role === 'assistant'
  const suggestions = assistant && Array.isArray(message.metadata?.suggestions)
    ? message.metadata.suggestions.filter((value): value is string => typeof value === 'string')
    : []
  return <article className={clsx('flex', assistant ? 'justify-start' : 'justify-end')}>
    <div className={clsx('max-w-[85%] rounded-2xl border px-4 py-3', assistant ? 'bg-hub-surface border-hub-border rounded-tl-sm' : 'bg-hub-accent-bg/20 border-hub-accent/30 rounded-tr-sm')}>
      <div className="flex items-center gap-2 mb-2 text-[9px] uppercase tracking-[0.15em] text-hub-text-muted"><span>{assistant ? 'Agent' : 'You'}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></div>
      <div className="markdown-body text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
      {suggestions.length > 0 && <div className="mt-3 flex flex-wrap gap-2 border-t border-hub-border/70 pt-3">
        {suggestions.map((suggestion) => <button key={suggestion} onClick={() => onSuggestion(suggestion)} className="rounded-lg border border-hub-accent/35 bg-hub-accent/5 px-2.5 py-1.5 text-[10px] text-hub-accent hover:bg-hub-accent/15">{suggestion}</button>)}
      </div>}
    </div>
  </article>
}

function ProgressPanel({ detail }: { detail: XjSessionDetail }) {
  return <section className="rounded-xl border border-hub-border bg-hub-surface/50 p-3">
    <div className="flex items-center justify-between text-xs"><strong>任务进度</strong><span className="text-hub-accent font-mono">{detail.progress.percent}%</span></div>
    <div className="mt-2 h-1.5 rounded-full bg-hub-border overflow-hidden"><div className="h-full bg-gradient-to-r from-cyan-400 to-hub-accent transition-all" style={{ width: `${detail.progress.percent}%` }} /></div>
    <p className="text-[10px] leading-5 text-hub-text-muted mt-2">{detail.progress.summary || '等待 Agent 上报进度'}</p>
    {detail.progress.todo.length > 0 && <div className="mt-2 space-y-1">{detail.progress.todo.slice(0, 5).map((todo, index) => <div key={`${todo}-${index}`} className="text-[10px] text-hub-text"><span className="text-hub-text-muted mr-1.5">□</span>{todo}</div>)}</div>}
  </section>
}

function AutomationPanel({ detail, onSave, onRefresh }: { detail: XjSessionDetail; onSave: (patch: Parameters<typeof api.xj.setAutomation>[1]) => Promise<void>; onRefresh: () => Promise<void> }) {
  const [limit, setLimit] = useState(detail.automation.loopLimit)
  const [criteria, setCriteria] = useState(detail.automation.acceptanceCriteria.join('\n'))
  useEffect(() => { setLimit(detail.automation.loopLimit); setCriteria(detail.automation.acceptanceCriteria.join('\n')) }, [detail.session.id, detail.automation.loopLimit, detail.automation.acceptanceCriteria])
  const running = detail.automation.state === 'running'
  return <section>
    <SectionTitle title="挂机循环" suffix={`${detail.automation.loop}/${detail.automation.loopLimit}`} />
    <div className="rounded-xl border border-hub-border bg-hub-surface/50 p-3 space-y-3">
      <div className="flex gap-2">
        <button onClick={async () => { running ? await api.xj.pause(detail.session.id) : await api.xj.resume(detail.session.id); await onRefresh() }} className={clsx('flex-1 py-1.5 rounded-lg text-xs border', running ? 'border-hub-orange/50 text-hub-orange' : 'border-hub-green/50 text-hub-green')}>{running ? '暂停' : '恢复'}</button>
        <button onClick={() => void onSave({ enabled: true, state: 'running', loop_limit: limit, acceptance_criteria: criteria.split('\n').map((v) => v.trim()).filter(Boolean) })} className="flex-1 py-1.5 rounded-lg text-xs bg-hub-accent-bg text-white">保存并启动</button>
      </div>
      <label className="block text-[10px] text-hub-text-muted">循环上限<input type="number" min={1} max={10000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="mt-1 w-full rounded-md border border-hub-border bg-hub-bg px-2 py-1.5 text-xs text-hub-text" /></label>
      <label className="block text-[10px] text-hub-text-muted">冻结验收标准<textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="每行一条" className="mt-1 w-full min-h-20 rounded-md border border-hub-border bg-hub-bg px-2 py-2 text-xs text-hub-text resize-y" /></label>
      {detail.automation.pauseReason && <div className="text-[10px] text-hub-orange">暂停原因：{detail.automation.pauseReason}</div>}
    </div>
  </section>
}

function SectionTitle({ title, suffix }: { title: string; suffix?: string }) {
  return <div className="flex items-center gap-2 mb-2"><h3 className="text-[10px] uppercase tracking-[0.18em] text-hub-text-muted font-semibold">{title}</h3>{suffix && <span className="ml-auto text-[9px] font-mono text-hub-text-muted">{suffix}</span>}</div>
}

function ResizeHandle({ pane }: { pane: ReturnType<typeof useResizableWidth> }) {
  return <div onMouseDown={pane.onMouseDown} onDoubleClick={pane.reset} className={clsx('w-[5px] flex-shrink-0 cursor-col-resize relative transition-colors z-10', pane.dragging ? 'bg-hub-accent' : 'bg-hub-border hover:bg-hub-accent/60')} title="拖拽调宽 · 双击重置" />
}
