import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { playNotifySound, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import {
  buildRrLaunchPrompt,
  DEFAULT_RR_AGENT_NAME,
  DEFAULT_RR_AGENT_ROLE,
  shouldNotifyRr,
  statusLabel,
  statusTone,
} from '../lib/rr'
import type { RrMessage, RrSession, RrSessionDetail, RrSubagent } from '../types/rr'

const seenAssistantMessages = new Set<string>()
const hydratedSessions = new Set<string>()

export function RrPage() {
  const [sessions, setSessions] = useState<RrSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RrSessionDetail | null>(null)
  const [subagents, setSubagents] = useState<RrSubagent[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)

  const refreshSessions = useCallback(async () => {
    const result = await api.rr.sessions()
    setSessions(result.sessions)
    setSelectedId((current) => current && result.sessions.some((session) => session.sessionId === current)
      ? current
      : result.sessions[0]?.sessionId ?? null)
  }, [])

  const refreshDetail = useCallback(async (sessionId: string) => {
    const [next, agents] = await Promise.all([api.rr.detail(sessionId), api.rr.subagents(sessionId)])
    setDetail(next)
    setSubagents(agents.subagents)
    const firstLoad = !hydratedSessions.has(sessionId)
    for (const message of next.history) {
      if (!firstLoad && shouldNotifyRr(message, seenAssistantMessages)) {
        showDesktopNotification(`Rr · ${next.session.title}`, message.content, message.msgId)
        playNotifySound()
      }
      if (message.role === 'assistant') seenAssistantMessages.add(message.msgId)
    }
    hydratedSessions.add(sessionId)
  }, [])

  const refresh = useCallback(async () => {
    try {
      await refreshSessions()
      if (selectedId) await refreshDetail(selectedId)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refreshDetail, refreshSessions, selectedId])

  useEffect(() => {
    requestNotificationPermission()
    void refreshSessions()
  }, [refreshSessions])

  useEffect(() => {
    if (selectedId) void refreshDetail(selectedId)
    else setDetail(null)
  }, [refreshDetail, selectedId])

  useEffect(() => {
    const source = new EventSource('/api/ui/rr/stream')
    const update = () => void refresh()
    for (const event of ['rr_store_changed', 'rr_session_updated', 'rr_message_created', 'rr_session_removed']) {
      source.addEventListener(event, update)
    }
    return () => source.close()
  }, [refresh])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [detail?.history.length])

  const selected = useMemo(
    () => sessions.find((session) => session.sessionId === selectedId) ?? detail?.session,
    [detail?.session, selectedId, sessions],
  )

  const createSession = async () => {
    setBusy(true)
    try {
      const launchId = `rrlaunch-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
      const result = await api.rr.createSession({ launchId, name: DEFAULT_RR_AGENT_NAME, role: DEFAULT_RR_AGENT_ROLE })
      await refreshSessions()
      setSelectedId(result.session.sessionId)
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const copyPrompt = async () => {
    if (!selected) return
    await navigator.clipboard.writeText(buildRrLaunchPrompt(selected))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const toggleSubagent = async () => {
    if (!selected) return
    setBusy(true)
    try {
      await api.rr.update(selected.sessionId, { isSubagent: !selected.isSubagent })
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const send = async () => {
    if (!selected || !draft.trim() || busy) return
    const content = draft.trim()
    setDraft('')
    setBusy(true)
    try {
      await api.rr.send(selected.sessionId, content)
      await refreshDetail(selected.sessionId)
    } catch (cause) {
      setDraft(content)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  return <div className="rr-shell -m-5 flex min-h-[calc(100vh-96px)] overflow-hidden border-t border-hub-border text-hub-text">
    <aside className="rr-sidebar flex w-64 shrink-0 flex-col border-r border-hub-border bg-hub-surface/70">
      <div className="flex items-center justify-between border-b border-hub-border p-4">
        <div><h1 className="text-base font-semibold">Rr</h1><p className="text-[10px] text-hub-text-muted">LOCAL INFINITE MCP</p></div>
        <button disabled={busy} onClick={() => void createSession()} className="rounded-lg border border-cyan-400/35 px-3 py-1.5 text-xs text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40">＋</button>
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {sessions.map((session) => <button key={session.sessionId} onClick={() => setSelectedId(session.sessionId)} className={clsx('w-full rounded-xl border p-3 text-left transition-colors', selectedId === session.sessionId ? 'border-cyan-400/45 bg-cyan-400/[0.08]' : 'border-transparent hover:border-hub-border hover:bg-hub-border/30')}>
          <div className="flex items-center gap-2"><span className={clsx('h-2 w-2 rounded-full', session.status === 'offline' ? 'bg-hub-text-muted' : session.status === 'working' ? 'bg-hub-accent' : 'bg-hub-green')} /><strong className="min-w-0 flex-1 truncate text-xs">{session.title || session.name}</strong>{session.isSubagent && <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[8px] text-violet-300">SUB</span>}</div>
          <div className="mt-2 truncate font-mono text-[8px] text-hub-text-muted">{session.sessionId}</div>
          <div className="mt-1 text-[9px] text-hub-text-muted">{statusLabel(session.status)} · inbox {session.pendingMessages}</div>
        </button>)}
        {sessions.length === 0 && <div className="p-5 text-center text-xs leading-6 text-hub-text-muted">点击＋创建第一个本地 Rr 会话</div>}
      </div>
    </aside>

    <main className="flex min-w-0 flex-1 flex-col bg-hub-bg/80">
      <header className="flex h-16 items-center gap-3 border-b border-hub-border px-5">
        <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{selected?.title ?? 'Rr 本地会话'}</h2><p className="truncate font-mono text-[9px] text-hub-text-muted">{selected?.sessionId ?? '尚未创建'}</p></div>
        {selected && <span className={clsx('rounded-full border px-2.5 py-1 text-[9px]', statusTone(selected.status))}>{statusLabel(selected.status)}</span>}
      </header>
      <div ref={transcriptRef} className="flex-1 space-y-4 overflow-y-auto p-5">
        {detail?.history.map((message) => <MessageBubble key={message.msgId} message={message} />)}
        {!detail?.history.length && <div className="mx-auto mt-20 max-w-md text-center text-xs leading-6 text-hub-text-muted">复制启动 Prompt 到 Cursor 会话，Agent 注册后即可从这里发送任务。Rr 的数据和 MCP 进程只在本机运行。</div>}
      </div>
      <div className="border-t border-hub-border p-4">
        {error && <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[10px] text-red-300">{error}</div>}
        <div className="flex gap-2 rounded-xl border border-hub-border bg-hub-surface p-2 focus-within:border-cyan-400/45">
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send() } }} disabled={!selected} placeholder="向当前 Rr 会话发送任务 · ⌘/Ctrl+Enter" className="min-h-20 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-hub-text-muted disabled:opacity-40" />
          <button onClick={() => void send()} disabled={!selected || !draft.trim() || busy} className="self-end rounded-lg bg-hub-accent-bg px-4 py-2 text-xs text-white disabled:opacity-35">发送</button>
        </div>
      </div>
    </main>

    <aside className="w-80 shrink-0 space-y-4 overflow-y-auto border-l border-hub-border bg-hub-surface/60 p-4">
      <section className="rounded-xl border border-hub-border bg-hub-bg/60 p-4">
        <h3 className="text-xs font-semibold">本地接入</h3>
        <p className="mt-2 text-[10px] leading-5 text-hub-text-muted">MCP：rr-chat<br />数据：~/.rr-cursor/chat</p>
        <button onClick={() => void copyPrompt()} disabled={!selected} className="mt-3 w-full rounded-lg border border-cyan-400/35 py-2 text-xs text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-35">{copied ? '已复制' : '复制启动 Prompt'}</button>
      </section>

      {selected && <section className="rounded-xl border border-hub-border bg-hub-bg/60 p-4">
        <div className="flex items-center justify-between gap-3"><div><h3 className="text-xs font-semibold">子 Agent</h3><p className="mt-1 text-[9px] text-hub-text-muted">动态加入本机调度池</p></div><button onClick={() => void toggleSubagent()} disabled={busy} className={clsx('relative h-6 w-11 rounded-full transition-colors', selected.isSubagent ? 'bg-violet-500' : 'bg-hub-border')}><span className={clsx('absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform', selected.isSubagent && 'translate-x-5')} /></button></div>
        {selected.activeTask && <div className="mt-3 rounded-lg border border-hub-accent/30 bg-hub-accent/5 p-3"><div className="font-mono text-[9px] text-hub-accent">{selected.activeTask.taskId}</div><p className="mt-2 line-clamp-3 text-[10px] leading-5 text-hub-text-muted">{selected.activeTask.content}</p>{selected.activeTask.progress && <div className="mt-2 text-[10px] text-cyan-300">{selected.activeTask.progress.percent ?? '?'}% · {selected.activeTask.progress.text}</div>}</div>}
      </section>}

      <section>
        <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-hub-text-muted">可调度会话</h3>
        <div className="space-y-2">{subagents.map((agent) => <div key={agent.sessionId} className="rounded-lg border border-hub-border bg-hub-bg/50 p-3"><div className="flex items-center gap-2"><strong className="min-w-0 flex-1 truncate text-[11px]">{agent.name}</strong><span className={clsx('text-[9px]', agent.availability === 'idle' ? 'text-hub-green' : agent.availability === 'busy' ? 'text-hub-accent' : 'text-hub-text-muted')}>{agent.availability}</span></div>{agent.activeTask?.progress && <p className="mt-2 text-[9px] text-hub-text-muted">{agent.activeTask.progress.percent ?? '?'}% · {agent.activeTask.progress.text}</p>}</div>)}{subagents.length === 0 && <p className="text-[10px] leading-5 text-hub-text-muted">其他会话打开“子 Agent”开关后会出现在这里。</p>}</div>
      </section>
    </aside>
  </div>
}

function MessageBubble({ message }: { message: RrMessage }) {
  const assistant = message.role === 'assistant'
  const suggestions = assistant && Array.isArray(message.metadata?.suggestions)
    ? message.metadata.suggestions.filter((value): value is string => typeof value === 'string')
    : []
  return <article className={clsx('flex', assistant ? 'justify-start' : 'justify-end')}>
    <div className={clsx('max-w-[85%] rounded-2xl border px-4 py-3', assistant ? 'rounded-tl-sm border-hub-border bg-hub-surface' : 'rounded-tr-sm border-hub-accent/30 bg-hub-accent-bg/20')}>
      <div className="mb-2 flex items-center gap-2 text-[9px] uppercase tracking-[0.15em] text-hub-text-muted"><span>{assistant ? 'Rr Agent' : message.role === 'system' ? 'Rr System' : 'You'}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></div>
      <div className="markdown-body text-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
      {suggestions.length > 0 && <div className="mt-3 flex flex-wrap gap-2 border-t border-hub-border/70 pt-3">{suggestions.map((suggestion) => <span key={suggestion} className="rounded-lg border border-hub-accent/35 px-2.5 py-1.5 text-[10px] text-hub-accent">{suggestion}</span>)}</div>}
    </div>
  </article>
}
