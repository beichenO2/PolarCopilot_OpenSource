import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { api } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'
import { playNotifySound, requestNotificationPermission, showDesktopNotification } from '../lib/notify'
import {
  buildRrLaunchPrompt,
  buildRrSessionForest,
  loadRrLastReadMap,
  partitionSessionsByLiveness,
  partitionSubagentsByLiveness,
  saveRrLastReadMap,
  sessionNeedsAttention,
  shouldNotifyRr,
  sortSessionsByUrgency,
  sortSubagentsByUrgency,
  statusLabel,
  statusTone,
} from '../lib/rr'
import {
  formatAfkTaskStatusLabel,
  formatActiveAfkTasksLabel,
  listHistoryAfkSummaries,
  listNowAfkSummaries,
  needsHumanReview,
  pickPrimaryAfkSummary,
} from '../lib/rr-afk'
import type {
  RrMessage,
  RrSession,
  RrSessionDetail,
  RrSpawnQueueBatch,
  RrSubagent,
  RrAfkStatus,
  RrAfkDecisionsReportItem,
  RrAfkSummary,
  RrAfkMode,
  RrOrchestratorConfig,
} from '../types/rr'

const AFK_MODE_LABELS: Record<RrAfkMode, string> = {
  start: '协作 start',
  solo: '自治 solo',
  go: 'Go 单主',
}

function formatAfkModeLabel(mode: RrAfkMode): string {
  return AFK_MODE_LABELS[mode]
}

const seenAssistantMessages = new Set<string>()
const hydratedSessions = new Set<string>()

function formatSpawnBatchProgress(batch: RrSpawnQueueBatch | null): string {
  if (!batch) return ''
  const done = batch.jobs.filter((job) => job.status === 'done').length
  const failed = batch.jobs.filter((job) => job.status === 'failed').length
  const active = batch.jobs.find((job) => job.status === 'spawning' || job.status === 'waiting_online')
  const parts = [`队列 ${done}/${batch.jobs.length}`]
  if (active) parts.push(`${active.label}：${active.status === 'waiting_online' ? '等待接通' : '启动中'}`)
  if (failed > 0) parts.push(`${failed} 失败`)
  return parts.join(' · ')
}

interface MessageAnnotation {
  id: string
  text: string
  note: string
  messageId: string
}

function afkTaskStatusTone(status: RrAfkSummary['status']): string {
  switch (status) {
    case 'NEEDS_HUMAN':
      return 'border-amber-400/50 text-amber-200 bg-amber-400/10'
    case 'RUNNING':
    case 'READY':
      return 'border-hub-green/40 text-hub-green bg-hub-green/5'
    case 'PAUSED':
    case 'BLOCKED':
      return 'border-amber-400/35 text-amber-300 bg-amber-400/5'
    case 'DONE':
      return 'border-hub-border text-hub-text-muted bg-hub-border/20'
    default:
      return 'border-cyan-400/35 text-cyan-200 bg-cyan-400/5'
  }
}

export function AfkPermissionReviewCard({
  summary,
  busy,
  onGrant,
}: {
  summary: RrAfkSummary
  busy: boolean
  onGrant: (taskId: string, paths: string[]) => void
}) {
  const request = summary.permission_request
  if (!request) return null

  return (
    <div className="mt-2 rounded-lg border border-amber-400/45 bg-amber-400/10 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-amber-100">需要人工审核</p>
          <p className="mt-1 text-[10px] leading-5 text-amber-100/90">
            任务 <span className="font-mono">{summary.task_id}</span>
            {summary.current_unit ? ` · 单元 ${summary.current_unit}` : ''}
            {summary.human_action_hint ? ` · ${summary.human_action_hint}` : ''}
          </p>
          <ul className="mt-2 space-y-1 font-mono text-[9px] text-amber-50/90">
            {request.paths.map((path) => (
              <li key={path} className="truncate" title={path}>{path}</li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onGrant(summary.task_id, request.paths)}
          className="shrink-0 rounded-lg border border-amber-300/50 bg-amber-300/15 px-3 py-1.5 text-[10px] font-medium text-amber-50 hover:bg-amber-300/25 disabled:opacity-35"
        >
          一键授权路径
        </button>
      </div>
    </div>
  )
}

function formatAfkLastInject(ts: number | null): string {
  if (!ts) return '尚无'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatAfkOrchestrator(state: RrAfkStatus['orchestrator']): string {
  if (state.running) return '运行中'
  if (state.enabled) return '已启用·未运行'
  return '已停止'
}

export function SubagentCreationPolicyToggle({
  allowNewSubagents,
  busy,
  onToggle,
}: {
  allowNewSubagents: boolean
  busy: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={allowNewSubagents}
      aria-label="是否允许开启新 Subagent"
      title="只控制之后创建的 Subagent；现有 Agent 不受影响"
      disabled={busy}
      onClick={onToggle}
      className={clsx(
        'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-wait disabled:opacity-60',
        allowNewSubagents
          ? 'border-cyan-400/30 bg-cyan-400/5 hover:bg-cyan-400/10'
          : 'border-amber-400/30 bg-amber-400/5 hover:bg-amber-400/10',
      )}
    >
      <span className="min-w-0">
        <span className="block text-[10px] font-medium text-hub-text">
          {allowNewSubagents ? '允许新 Subagent' : '禁止新 Subagent'}
        </span>
        <span className="mt-0.5 block truncate text-[9px] text-hub-text-muted">
          仅影响之后创建的 Agent
        </span>
      </span>
      <span
        aria-hidden="true"
        className={clsx(
          'relative h-4 w-7 shrink-0 rounded-full transition-colors',
          allowNewSubagents ? 'bg-cyan-400/70' : 'bg-hub-border',
        )}
      >
        <span className={clsx(
          'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
          allowNewSubagents ? 'translate-x-3.5' : 'translate-x-0.5',
        )} />
      </span>
    </button>
  )
}

export function RrPage() {
  const [sessions, setSessions] = useState<RrSession[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RrSessionDetail | null>(null)
  const [subagents, setSubagents] = useState<RrSubagent[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [spawnInfo, setSpawnInfo] = useState('')
  const [spawnBatch, setSpawnBatch] = useState<RrSpawnQueueBatch | null>(null)
  const [defaultWorkspace, setDefaultWorkspace] = useState('')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /** 进程树展开键；默认折叠，不占垂直空间 */
  const [expandedProcessKeys, setExpandedProcessKeys] = useState<Set<string>>(new Set())
  /** Sidebar live filter: default live-only per DESIGN */
  const [sidebarFilter, setSidebarFilter] = useState<'live' | 'all'>('live')
  const [offlineSectionExpanded, setOfflineSectionExpanded] = useState(false)
  const [offlineDispatchSubagentsExpanded, setOfflineDispatchSubagentsExpanded] = useState(false)
  const [offlineNowSubagentsExpanded, setOfflineNowSubagentsExpanded] = useState(false)
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [annotations, setAnnotations] = useState<MessageAnnotation[]>([])
  const [annotating, setAnnotating] = useState<{ text: string; messageId: string } | null>(null)
  const [annotationNote, setAnnotationNote] = useState('')
  const [lastReadMap, setLastReadMap] = useState<Record<string, number>>(() => loadRrLastReadMap())
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [afkStatus, setAfkStatus] = useState<RrAfkStatus | null>(null)
  const [afkReport, setAfkReport] = useState<RrAfkDecisionsReportItem[]>([])
  const [afkBusy, setAfkBusy] = useState(false)
  const [grantBusy, setGrantBusy] = useState(false)
  const [afkInfo, setAfkInfo] = useState('')
  const [afkMode, setAfkMode] = useState<RrAfkMode>('solo')
  const [afkTaskSlug, setAfkTaskSlug] = useState('')
  const [orchestratorConfig, setOrchestratorConfig] = useState<RrOrchestratorConfig | null>(null)
  const [orchestratorConfigBusy, setOrchestratorConfigBusy] = useState(false)
  const transcriptRef = useRef<HTMLDivElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const annPopoverRef = useRef<HTMLDivElement>(null)
  const selectedIdRef = useRef<string | null>(null)
  const deletedSessionIdsRef = useRef<Set<string>>(new Set())
  const detailFetchGenRef = useRef(0)

  selectedIdRef.current = selectedId

  const refreshAfkStatus = useCallback(async () => {
    try {
      const status = await api.rr.afkStatus()
      setAfkStatus(status)
      if (status.summaries?.length || status.active) {
        try {
          const report = await api.rr.afkReport()
          setAfkReport(report.items)
        } catch {
          setAfkReport([])
        }
      } else {
        setAfkReport([])
      }
    } catch {
      setAfkStatus(null)
      setAfkReport([])
    }
  }, [])

  const refreshOrchestratorConfig = useCallback(async () => {
    try {
      setOrchestratorConfig(await api.rr.orchestratorConfig())
    } catch {
      setOrchestratorConfig(null)
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    const result = await api.rr.sessions()
    setSessions(result.sessions)
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => result.sessions.some((session) => session.sessionId === id)))
      return next.size === current.size ? current : next
    })
    setSelectedId((current) => current && result.sessions.some((session) => session.sessionId === current)
      ? current
      : result.sessions[0]?.sessionId ?? null)
  }, [])

  const markSessionRead = useCallback((sessionId: string, messageTs?: number) => {
    const ts = messageTs && messageTs > 0 ? messageTs : Date.now()
    setLastReadMap((current) => {
      if ((current[sessionId] ?? 0) >= ts) return current
      const next = { ...current, [sessionId]: ts }
      saveRrLastReadMap(next)
      return next
    })
  }, [])

  const markSessionDeleted = useCallback((sessionId: string) => {
    deletedSessionIdsRef.current.add(sessionId)
    hydratedSessions.delete(sessionId)
    detailFetchGenRef.current += 1
    if (selectedIdRef.current === sessionId) {
      selectedIdRef.current = null
      setSelectedId(null)
      setDetail(null)
    }
  }, [])

  const refreshDetail = useCallback(async (sessionId: string) => {
    if (deletedSessionIdsRef.current.has(sessionId)) return
    const fetchGen = detailFetchGenRef.current + 1
    detailFetchGenRef.current = fetchGen
    try {
      const [next, agents] = await Promise.all([api.rr.detail(sessionId), api.rr.subagents(sessionId)])
      if (fetchGen !== detailFetchGenRef.current) return
      if (deletedSessionIdsRef.current.has(sessionId)) return
      if (!next) {
        markSessionDeleted(sessionId)
        await refreshSessions()
        return
      }
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
      const latestTs = next.history.reduce((max, message) => Math.max(max, message.createdAt), next.session.lastMessageTs ?? 0)
      markSessionRead(sessionId, latestTs)
    } catch (cause) {
      if (fetchGen !== detailFetchGenRef.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.includes(': 404') || message.includes('session_not_found')) {
        markSessionDeleted(sessionId)
        await refreshSessions()
        return
      }
      throw cause
    }
  }, [markSessionDeleted, markSessionRead, refreshSessions])

  const refresh = useCallback(async () => {
    try {
      await refreshSessions()
      await refreshAfkStatus()
      const id = selectedIdRef.current
      if (id && !deletedSessionIdsRef.current.has(id)) await refreshDetail(id)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [refreshAfkStatus, refreshDetail, refreshSessions])

  useEffect(() => {
    requestNotificationPermission()
    void refreshSessions()
    void refreshAfkStatus()
    void refreshOrchestratorConfig()
    void api.rr.runtime()
      .then((runtime) => setDefaultWorkspace(runtime.defaultWorkspace))
      .catch(() => setDefaultWorkspace(''))
  }, [refreshSessions, refreshAfkStatus, refreshOrchestratorConfig])

  useEffect(() => {
    if (!selectedId || deletedSessionIdsRef.current.has(selectedId)) {
      setDetail(null)
      return
    }
    void refreshDetail(selectedId)
  }, [refreshDetail, selectedId])

  useEffect(() => {
    const source = new EventSource('/api/ui/rr/stream')
    const refreshActive = () => void refresh()
    for (const event of ['rr_store_changed', 'rr_session_updated', 'rr_message_created']) {
      source.addEventListener(event, refreshActive)
    }
    source.addEventListener('rr_session_removed', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { sessionId?: string }
        if (payload.sessionId) markSessionDeleted(payload.sessionId)
      } catch {
        // ignore malformed SSE payloads
      }
      void refreshSessions()
    })
    source.addEventListener('rr_spawn_queue_updated', (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { batch?: RrSpawnQueueBatch | null }
        if (payload.batch) {
          setSpawnBatch(payload.batch)
          setSpawnInfo(formatSpawnBatchProgress(payload.batch))
          if (payload.batch.status === 'completed' || payload.batch.status === 'failed') {
            void refreshActive()
          }
        }
      } catch {
        // ignore malformed SSE payloads
      }
    })
    source.addEventListener('rr_afk_updated', () => {
      void refreshAfkStatus()
    })
    source.addEventListener('rr_orchestrator_config_updated', () => {
      void refreshOrchestratorConfig()
    })
    return () => source.close()
  }, [markSessionDeleted, refresh, refreshAfkStatus, refreshOrchestratorConfig, refreshSessions])

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 15_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' })
  }, [detail?.history.length])

  useEffect(() => {
    setAnnotations([])
    setAnnotating(null)
    setAnnotationNote('')
  }, [selectedId])

  const selected = useMemo(
    () => sessions.find((session) => session.sessionId === selectedId) ?? detail?.session,
    [detail?.session, selectedId, sessions],
  )

  const primaryAfkSummary = useMemo(
    () => pickPrimaryAfkSummary(afkStatus),
    [afkStatus],
  )

  const activeAfkTaskCount = useMemo(
    () => formatActiveAfkTasksLabel(afkStatus),
    [afkStatus],
  )

  const nowAfkSummaries = useMemo(
    () => listNowAfkSummaries(afkStatus),
    [afkStatus],
  )

  const historyAfkSummaries = useMemo(
    () => listHistoryAfkSummaries(afkStatus),
    [afkStatus],
  )

  const livenessPartition = useMemo(
    () => partitionSessionsByLiveness(sessions),
    [sessions],
  )

  const sidebarSourceSessions = useMemo(() => {
    const source = sidebarFilter === 'live' ? livenessPartition.live : sessions
    return sortSessionsByUrgency(source)
  }, [sidebarFilter, livenessPartition.live, sessions])

  const sortedOfflineSessions = useMemo(
    () => sortSessionsByUrgency(livenessPartition.offline),
    [livenessPartition.offline],
  )

  const subagentLivenessPartition = useMemo(
    () => partitionSubagentsByLiveness(subagents),
    [subagents],
  )

  const sortedLiveSubagents = useMemo(
    () => sortSubagentsByUrgency(subagentLivenessPartition.live),
    [subagentLivenessPartition.live],
  )

  const sortedOfflineSubagents = useMemo(
    () => sortSubagentsByUrgency(subagentLivenessPartition.offline),
    [subagentLivenessPartition.offline],
  )

  const primaryMasterSessionId = useMemo(
    () => primaryAfkSummary?.master_session_id ?? afkStatus?.orchestrator.masterSessionId ?? selectedId,
    [afkStatus?.orchestrator.masterSessionId, primaryAfkSummary?.master_session_id, selectedId],
  )

  const humanReviewSummaries = useMemo(
    () => (afkStatus?.summaries ?? []).filter((summary) => needsHumanReview(summary)),
    [afkStatus?.summaries],
  )

  const sessionForest = useMemo(() => buildRrSessionForest(sidebarSourceSessions), [sidebarSourceSessions])

  const offlineForest = useMemo(
    () => buildRrSessionForest(sortedOfflineSessions),
    [sortedOfflineSessions],
  )

  const activeTaskGroup = useMemo(() => {
    if (!primaryMasterSessionId) return null
    const byMain = sessionForest.groups.find((group) => group.main.sessionId === primaryMasterSessionId)
    if (byMain) return byMain
    return sessionForest.groups.find((group) =>
      group.children.some((child) => child.sessionId === primaryMasterSessionId),
    ) ?? null
  }, [primaryMasterSessionId, sessionForest.groups])

  const secondaryNowSummaries = useMemo(
    () => nowAfkSummaries.filter((summary) => summary.task_id !== primaryAfkSummary?.task_id),
    [nowAfkSummaries, primaryAfkSummary?.task_id],
  )

  // 选中子 Agent 时自动展开其所属主进程，避免折叠后找不到当前会话
  useEffect(() => {
    if (!selectedId) return
    const host = sessionForest.groups.find((group) => group.children.some((child) => child.sessionId === selectedId))
    if (!host) return
    setExpandedProcessKeys((current) => {
      if (current.has(host.key)) return current
      const next = new Set(current)
      next.add(host.key)
      return next
    })
  }, [selectedId, sessionForest.groups])

  const toggleProcessExpand = (key: string) => {
    setExpandedProcessKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const toggleAllowNewSubagents = async () => {
    if (!orchestratorConfig || orchestratorConfigBusy) return
    const next = !orchestratorConfig.allowNewSubagents
    setOrchestratorConfigBusy(true)
    setError('')
    try {
      setOrchestratorConfig(await api.rr.updateOrchestratorConfig({ allowNewSubagents: next }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setOrchestratorConfigBusy(false)
    }
  }

  /** 新建进程：Hub 串行 spawn 队列（主 → 等上线 → 间隔 → 子1 → 子2） */
  const createProcess = async () => {
    setBusy(true)
    setSpawnInfo('正在创建进程并加入 spawn 队列…')
    setSpawnBatch(null)
    setError('')
    try {
      const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      const stamp = `${time}-${Math.random().toString(36).slice(2, 6)}`
      const result = await api.rr.spawnProcess({
        stamp,
        workspace: defaultWorkspace || undefined,
        subCount: orchestratorConfig?.allowNewSubagents === false ? 0 : 2,
      })

      setSpawnBatch(result.batch)
      setSelectedId(result.mainSessionId)
      setSpawnInfo(formatSpawnBatchProgress(result.batch) || '已入队，逐个启动 Agent…')
      await refreshSessions()

      const deadline = Date.now() + 300_000
      while (Date.now() < deadline) {
        const next = await api.rr.spawnQueueBatch(result.batchId)
        setSpawnBatch(next.batch)
        setSpawnInfo(formatSpawnBatchProgress(next.batch))
        if (next.batch.status === 'completed') {
          await refreshDetail(result.mainSessionId)
          setSpawnInfo(`进程就绪：主 + ${result.subSessionIds.length} 子均已按队列启动完成`)
          break
        }
        if (next.batch.status === 'failed') {
          const failed = next.batch.jobs.filter((job) => job.status === 'failed')
          setError(`部分 Agent 启动失败：${failed.map((job) => job.label).join('、')}。可点「启动 Cursor Agent」重试。`)
          await refresh()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setSpawnInfo('')
    } finally {
      setBusy(false)
    }
  }

  const oneClickAfk = async () => {
    setAfkBusy(true)
    setAfkInfo('正在设为 AFK active 并启动 orchestrator…')
    setError('')
    try {
      const result = await api.rr.afkOneClick({
        sessionId: selected?.sessionId,
        spawnIfNeeded: !selected,
        force: false,
        mode: afkMode,
        taskSlug: afkTaskSlug.trim() || undefined,
      })
      setAfkStatus(result.status)
      setAfkInfo(
        `一键 AFK 就绪 · 模式 ${formatAfkModeLabel(afkMode)} · 任务 ${result.armed.taskId} · 主会话 ${result.sessionId.slice(0, 12)}… · ${formatActiveAfkTasksLabel(result.status)} · orchestrator ${result.orchestrator.running ? '运行中' : '已配置'}`,
      )
      if (result.sessionId) setSelectedId(result.sessionId)
      // go 会 PATCH allowNewSubagents=false；必须同步左上角开关，避免 UI/Hub 不一致
      await Promise.all([refresh(), refreshOrchestratorConfig()])
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (message.includes('afk_budget_capacity')) {
        setError('已达 PolarBudget 并发上限（fleet-10 / recommended_jobs）。请等待其它任务 done 释放名额，或缩小并行规模。')
      } else if (message.includes('afk_already_active')) {
        setError('该 task slug 已在 active_tasks 中。请换 task slug，或使用 force 重绑同一任务。')
      } else if (message.includes('no_master_session')) {
        setError('无可用主会话，请先新建进程或启动 Cursor Agent')
      } else {
        setError(message)
      }
      setAfkInfo('')
    } finally {
      setAfkBusy(false)
    }
  }

  const grantTemporaryPaths = async (taskId: string, paths: string[]) => {
    setGrantBusy(true)
    setError('')
    try {
      const result = await api.rr.afkGrantTemporaryPaths(taskId, paths)
      setAfkInfo(`已授权 ${result.grantedPaths.length} 个路径 · 任务 ${taskId} → ${result.status}`)
      await refreshAfkStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setGrantBusy(false)
    }
  }

  const startOrchestrator = async () => {
    setAfkBusy(true)
    setError('')
    try {
      const result = await api.rr.afkOrchestratorStart()
      setAfkInfo(result.running ? 'Orchestrator 已启动' : 'Orchestrator 启动指令已发送')
      await refreshAfkStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAfkBusy(false)
    }
  }

  const haltOrchestrator = async () => {
    setAfkBusy(true)
    setError('')
    try {
      await api.rr.afkOrchestratorHalt()
      setAfkInfo('Orchestrator 已停止')
      await refreshAfkStatus()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAfkBusy(false)
    }
  }

  const spawnCursor = async () => {
    if (!selected) return
    setBusy(true)
    setSpawnInfo('已加入 spawn 队列…')
    try {
      const result = await api.rr.spawnCursorForSession(selected.sessionId, {
        workspace: defaultWorkspace || undefined,
        waitUntilOnline: true,
      })
      await refresh()
      setSpawnInfo(`已启动 Cursor Agent · pid ${result.spawn.pid} · ${result.spawn.workspace}`)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeAgent = async (sessionId: string) => {
    setBusy(true)
    markSessionDeleted(sessionId)
    try {
      await api.rr.remove(sessionId)
      setSelectedIds((current) => {
        const next = new Set(current)
        next.delete(sessionId)
        return next
      })
      await refreshSessions()
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeSelectedAgents = async () => {
    if (selectedIds.size === 0) return
    setBusy(true)
    try {
      const ids = [...selectedIds]
      for (const id of ids) markSessionDeleted(id)
      const results = await Promise.allSettled(ids.map((id) => api.rr.remove(id)))
      const failed = results.filter((result) => result.status === 'rejected').length
      setSelectedIds(new Set())
      await refreshSessions()
      setError(failed > 0 ? `批量删除完成，${failed} 个失败` : '')
      setSpawnInfo(`已批量删除 ${ids.length - failed} 个 Agent`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const toggleSelect = (sessionId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }

  const toggleSelectAll = () => {
    const visibleIds = sidebarSourceSessions.map((session) => session.sessionId)
    setSelectedIds((current) => {
      if (visibleIds.length > 0 && visibleIds.every((id) => current.has(id))) return new Set()
      return new Set(visibleIds)
    })
  }

  const renderSessionForest = (
    forest: ReturnType<typeof buildRrSessionForest>,
    emptyHint: string,
  ) => (
    <>
      {forest.groups.map((group) => {
        const expanded = expandedProcessKeys.has(group.key)
        const hasChildren = group.children.length > 0
        return (
          <div key={group.key} className="space-y-0.5">
            {renderSessionRow(group.main, {
              depth: 0,
              expand: hasChildren
                ? {
                    expanded,
                    childCount: group.children.length,
                    onToggle: () => toggleProcessExpand(group.key),
                  }
                : undefined,
            })}
            {hasChildren && expanded && group.children.map((child) => renderSessionRow(child, { depth: 1 }))}
          </div>
        )
      })}
      {forest.singles.map((session) => renderSessionRow(session, { depth: 0 }))}
      {forest.groups.length === 0 && forest.singles.length === 0 && (
        <div className="p-3 text-center text-[10px] leading-5 text-hub-text-muted">{emptyHint}</div>
      )}
    </>
  )

  const beginAnnotate = useCallback((messageId: string, text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setAnnotating({ text: trimmed, messageId })
    setAnnotationNote('')
  }, [])

  const addAnnotation = () => {
    if (!annotating || !annotationNote.trim()) return
    setAnnotations((prev) => [
      ...prev,
      {
        id: `ann-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        text: annotating.text,
        note: annotationNote.trim(),
        messageId: annotating.messageId,
      },
    ])
    setAnnotating(null)
    setAnnotationNote('')
    window.getSelection()?.removeAllRanges()
  }

  const removeAnnotation = (id: string) => {
    setAnnotations((prev) => prev.filter((item) => item.id !== id))
  }

  const applySuggestion = useCallback((text: string) => {
    const next = text.trim()
    if (!next) return
    setDraft(next)
    requestAnimationFrame(() => {
      const el = draftRef.current
      if (!el) return
      el.focus()
      const cursor = next.length
      el.setSelectionRange(cursor, cursor)
    })
  }, [])

  const send = async () => {
    if (!selected || busy) return
    const parts: string[] = []
    if (draft.trim()) parts.push(draft.trim())
    if (annotations.length > 0) {
      parts.push(annotations.map((item, index) => `【批注 ${index + 1}】"${item.text}"\n→ ${item.note}`).join('\n\n'))
    }
    if (parts.length === 0) return
    const content = parts.join('\n\n')
    const previousDraft = draft
    const previousAnnotations = annotations
    setDraft('')
    setAnnotations([])
    setAnnotating(null)
    setBusy(true)
    const optimistic: RrMessage = {
      msgId: `local-${Date.now()}`,
      sessionId: selected.sessionId,
      from: 'panel',
      to: selected.sessionId,
      role: 'user',
      content,
      createdAt: Date.now(),
      metadata: { type: 'user_task', optimistic: true },
    }
    setDetail((current) => current
      ? { ...current, history: [...current.history, optimistic] }
      : { session: selected, history: [optimistic] })
    try {
      await api.rr.send(selected.sessionId, content)
      await refreshDetail(selected.sessionId)
    } catch (cause) {
      setDraft(previousDraft)
      setAnnotations(previousAnnotations)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const canSend = Boolean(selected) && (draft.trim().length > 0 || annotations.length > 0) && !busy

  const beginRename = (session: RrSession) => {
    setRenamingId(session.sessionId)
    setRenameDraft(session.title || session.name)
  }

  const commitRename = async (sessionId: string) => {
    const nextTitle = renameDraft.trim().slice(0, 40)
    setRenamingId(null)
    if (!nextTitle) return
    const current = sessions.find((session) => session.sessionId === sessionId)
    if (current && (current.title || current.name) === nextTitle && current.titleLocked) return
    setBusy(true)
    setError('')
    try {
      await api.rr.update(sessionId, { title: nextTitle, titleLocked: true })
      await refreshSessions()
      if (selectedId === sessionId) await refreshDetail(sessionId)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const renderSessionRow = (
    session: RrSession,
    options: {
      depth: 0 | 1
      expand?: { expanded: boolean; childCount: number; onToggle: () => void }
    },
  ) => {
    const needsAttention = selectedId !== session.sessionId && sessionNeedsAttention(session, lastReadMap)
    const isRenaming = renamingId === session.sessionId
    return (
    <div
      key={session.sessionId}
      className={clsx(
        'group flex items-stretch gap-1 rounded-xl border transition-colors',
        options.depth === 1 && 'ml-4 border-l border-l-violet-400/25',
        selectedId === session.sessionId
          ? 'border-cyan-400/45 bg-cyan-400/[0.08]'
          : needsAttention
            ? 'border-amber-400/40 bg-amber-400/[0.07]'
            : 'border-transparent hover:border-hub-border hover:bg-hub-border/30',
      )}
    >
      {options.expand ? (
        <button
          type="button"
          title={options.expand.expanded ? '折叠子 Agent' : '展开子 Agent'}
          onClick={(event) => {
            event.stopPropagation()
            options.expand?.onToggle()
          }}
          className="flex w-6 shrink-0 items-start justify-center pt-3.5 text-[10px] text-hub-text-muted hover:text-hub-text"
        >
          {options.expand.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className={clsx('w-6 shrink-0', options.depth === 1 && 'w-3')} />
      )}
      <label className="flex shrink-0 items-start pt-3.5" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={selectedIds.has(session.sessionId)}
          onChange={() => toggleSelect(session.sessionId)}
          className="rounded border-hub-border"
        />
      </label>
      <button
        onClick={() => setSelectedId(session.sessionId)}
        className="min-w-0 flex-1 p-3 pl-1.5 text-left"
      >
        <div className="flex items-center gap-2">
          <span className={clsx('h-2 w-2 shrink-0 rounded-full', session.status === 'offline' ? 'bg-hub-text-muted' : session.status === 'working' ? 'bg-hub-accent' : 'bg-hub-green')} />
          {isRenaming ? (
            <input
              autoFocus
              value={renameDraft}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setRenameDraft(event.target.value)}
              onBlur={() => void commitRename(session.sessionId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitRename(session.sessionId)
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setRenamingId(null)
                }
              }}
              className="min-w-0 flex-1 truncate border-b border-cyan-400/50 bg-transparent text-xs font-semibold text-hub-text outline-none"
            />
          ) : (
            <strong
              className="min-w-0 flex-1 truncate text-xs"
              title={`${session.title || session.name}${session.titleLocked ? '（已锁定）' : ''} · 双击重命名`}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                beginRename(session)
              }}
            >
              {session.title || session.name}
            </strong>
          )}
          {needsAttention && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300 shadow-[0_0_6px_rgba(252,211,77,0.85)]" title="有新回复" />
          )}
          {options.expand && (
            <span className="rounded bg-hub-border/60 px-1.5 py-0.5 text-[8px] text-hub-text-muted">
              {options.expand.childCount} 子
            </span>
          )}
          {(session.isSubagent || options.depth === 1) && (
            <span className="rounded bg-violet-400/10 px-1.5 py-0.5 text-[8px] text-violet-300">SUB</span>
          )}
        </div>
        <div className="mt-2 truncate font-mono text-[8px] text-hub-text-muted">{session.sessionId}</div>
        <div className="mt-1 text-[9px] text-hub-text-muted">{statusLabel(session.status)} · inbox {session.pendingMessages}</div>
      </button>
      <button
        title="删除此 Agent"
        disabled={busy}
        onClick={(event) => {
          event.stopPropagation()
          void removeAgent(session.sessionId)
        }}
        className="shrink-0 px-2 text-[12px] text-hub-text-muted opacity-0 hover:text-red-300 group-hover:opacity-100 disabled:opacity-20"
      >
        ×
      </button>
    </div>
    )
  }

  return (
    <div className="rr-shell flex h-full min-h-0 overflow-hidden border-t border-hub-border text-hub-text">
      {/* 左栏：独立滚动 */}
      <aside className="rr-sidebar flex h-full w-64 shrink-0 flex-col overflow-hidden border-r border-hub-border bg-hub-surface/70">
        <div className="shrink-0 space-y-2 border-b border-hub-border p-4">
          {orchestratorConfig && (
            <SubagentCreationPolicyToggle
              allowNewSubagents={orchestratorConfig.allowNewSubagents}
              busy={orchestratorConfigBusy}
              onToggle={() => void toggleAllowNewSubagents()}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">Rr</h1>
              <p className="text-[10px] text-hub-text-muted">LOCAL INFINITE MCP</p>
            </div>
            <button
              disabled={busy}
              onClick={() => void createProcess()}
              title={orchestratorConfig?.allowNewSubagents === false
                ? '新建主进程；当前禁止创建新的 Subagent'
                : '新建进程：1 主 + 2 子，Hub 串行 spawn 队列逐个启动'}
              className="rounded-lg border border-cyan-400/35 px-2.5 py-1.5 text-[10px] text-cyan-300 hover:bg-cyan-400/10 disabled:opacity-40"
            >
              新建进程
            </button>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-hub-text-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={sidebarSourceSessions.length > 0 && sidebarSourceSessions.every((session) => selectedIds.has(session.sessionId))}
                onChange={toggleSelectAll}
                className="rounded border-hub-border"
              />
              全选
            </label>
            <span className="text-hub-border">·</span>
            <span>已选 {selectedIds.size}</span>
            <button
              disabled={busy || selectedIds.size === 0}
              onClick={() => void removeSelectedAgents()}
              className="ml-auto rounded border border-red-500/35 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-35"
            >
              批量删除
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => setSidebarFilter('live')}
              className={clsx(
                'rounded-full border px-2.5 py-0.5 text-[9px] font-medium transition-colors',
                sidebarFilter === 'live'
                  ? 'border-hub-green/45 bg-hub-green/10 text-hub-green'
                  : 'border-hub-border text-hub-text-muted hover:border-hub-border/80',
              )}
            >
              Live only ●
            </button>
            <button
              type="button"
              onClick={() => setSidebarFilter('all')}
              className={clsx(
                'rounded-full border px-2.5 py-0.5 text-[9px] font-medium transition-colors',
                sidebarFilter === 'all'
                  ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-200'
                  : 'border-hub-border text-hub-text-muted hover:border-hub-border/80',
              )}
            >
              全部
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
          {sidebarFilter === 'live' && (
            <p className="px-1 text-[9px] font-semibold uppercase tracking-[0.14em] text-hub-text-muted">
              Living ({livenessPartition.live.length})
            </p>
          )}
          {renderSessionForest(
            sessionForest,
            sidebarFilter === 'live' ? '暂无活体 Agent' : '点击「新建进程」：主/子 Agent 按队列逐个 spawn',
          )}
          {sidebarFilter === 'live' && sortedOfflineSessions.length > 0 && (
            <div className="border-t border-hub-border/60 pt-2">
              <button
                type="button"
                onClick={() => setOfflineSectionExpanded((current) => !current)}
                className="flex w-full items-center gap-2 px-1 py-1 text-left text-[9px] font-semibold uppercase tracking-[0.14em] text-hub-text-muted hover:text-hub-text"
              >
                <span>{offlineSectionExpanded ? '▾' : '▸'}</span>
                <span>Offline ({sortedOfflineSessions.length})</span>
              </button>
              {offlineSectionExpanded && (
                <div className="mt-1 space-y-0.5 opacity-80">
                  {renderSessionForest(offlineForest, '无离线 Agent')}
                </div>
              )}
            </div>
          )}
          {sessions.length === 0 && (
            <div className="p-5 text-center text-xs leading-6 text-hub-text-muted">
              点击「新建进程」：主/子 Agent 按队列逐个 spawn，避免同时抢 MCP
            </div>
          )}
        </div>
      </aside>

      {/* 中栏：消息区滚动，输入钉在可视区底部 */}
      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-hub-bg/80">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-hub-border px-5">
          <div className="min-w-0 flex-1">
            {selected && renamingId === selected.sessionId ? (
              <input
                autoFocus
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => void commitRename(selected.sessionId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitRename(selected.sessionId)
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setRenamingId(null)
                  }
                }}
                className="w-full max-w-md truncate border-b border-cyan-400/50 bg-transparent text-sm font-semibold outline-none"
              />
            ) : (
              <h2
                className="truncate text-sm font-semibold"
                title={selected ? `${selected.title}${selected.titleLocked ? '（已锁定）' : ''} · 双击重命名` : undefined}
                onDoubleClick={() => { if (selected) beginRename(selected) }}
              >
                {selected?.title ?? 'Rr 本地会话'}
              </h2>
            )}
            <p className="truncate font-mono text-[9px] text-hub-text-muted">{selected?.sessionId ?? '尚未创建'}</p>
          </div>
          {selected && (
            <span className={clsx('rounded-full border px-2.5 py-1 text-[9px]', statusTone(selected.status))}>
              {statusLabel(selected.status)}
            </span>
          )}
        </header>

        <div className="shrink-0 border-b border-hub-border bg-hub-surface/40 px-5 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[11px] font-semibold text-hub-text">NOW · Active Task</h3>
              <span className={clsx(
                'rounded-full border px-2 py-0.5 text-[9px]',
                sidebarFilter === 'live'
                  ? 'border-hub-green/40 text-hub-green'
                  : 'border-hub-border text-hub-text-muted',
              )}>
                {sidebarFilter === 'live' ? 'Live only' : 'All agents'}
              </span>
              <span className={clsx(
                'rounded-full border px-2 py-0.5 text-[9px]',
                afkStatus?.active ? 'border-hub-green/40 text-hub-green' : 'border-hub-border text-hub-text-muted',
              )}>
                {afkStatus?.active ? 'AFK active' : 'AFK inactive'}
              </span>
              {afkStatus?.active && (
                <span className="rounded-full border border-violet-400/35 bg-violet-400/10 px-2 py-0.5 font-mono text-[9px] text-violet-100">
                  {activeAfkTaskCount}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={afkTaskSlug}
                disabled={afkBusy || busy}
                onChange={(event) => setAfkTaskSlug(event.target.value)}
                placeholder="task slug（可选）"
                aria-label="AFK task slug"
                className="min-w-[8rem] rounded-lg border border-hub-border bg-hub-bg px-2 py-1.5 font-mono text-[10px] text-hub-text placeholder:text-hub-text-muted disabled:opacity-35"
              />
              <select
                value={afkMode}
                disabled={afkBusy || busy}
                onChange={(event) => setAfkMode(event.target.value as RrAfkMode)}
                aria-label="AFK 模式"
                className="rounded-lg border border-hub-border bg-hub-bg px-2 py-1.5 text-[10px] text-hub-text-muted disabled:opacity-35"
              >
                {(Object.keys(AFK_MODE_LABELS) as RrAfkMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {AFK_MODE_LABELS[mode]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={afkBusy || busy}
                onClick={() => void oneClickAfk()}
                className="rounded-lg border border-violet-400/45 bg-violet-400/10 px-3 py-1.5 text-[10px] font-medium text-violet-200 hover:bg-violet-400/15 disabled:opacity-35"
              >
                一键AFK
              </button>
              <button
                type="button"
                disabled={afkBusy}
                onClick={() => void startOrchestrator()}
                className="rounded-lg border border-cyan-400/35 px-2.5 py-1.5 text-[10px] text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-35"
              >
                启动 orchestrator
              </button>
              <button
                type="button"
                disabled={afkBusy}
                onClick={() => void haltOrchestrator()}
                className="rounded-lg border border-hub-border px-2.5 py-1.5 text-[10px] text-hub-text-muted hover:bg-hub-border/30 disabled:opacity-35"
              >
                停止 orchestrator
              </button>
            </div>
          </div>

          {primaryAfkSummary ? (
            <div className="mt-3 rounded-lg border border-cyan-400/30 bg-hub-bg/50 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs font-semibold text-hub-text">{primaryAfkSummary.task_id}</span>
                <span className={clsx('rounded-full border px-2 py-0.5 text-[9px]', afkTaskStatusTone(primaryAfkSummary.status))}>
                  {formatAfkTaskStatusLabel(primaryAfkSummary.status)}
                </span>
                {primaryAfkSummary.mode && (
                  <span className="rounded-full border border-violet-400/35 bg-violet-400/10 px-2 py-0.5 text-[9px] text-violet-200">
                    {formatAfkModeLabel(primaryAfkSummary.mode)}
                  </span>
                )}
                {primaryAfkSummary.current_unit && (
                  <span className="text-[10px] text-hub-text-muted">单元 {primaryAfkSummary.current_unit}</span>
                )}
                <span className="text-[10px] text-hub-text-muted">rev {primaryAfkSummary.plan_revision}</span>
                <span className="text-[10px] text-hub-text-muted">loop {primaryAfkSummary.loop}/{afkStatus?.maxLoops ?? 40}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-hub-text-muted">
                <span>TODO {afkStatus ? `${afkStatus.todo.done}/${afkStatus.todo.total}` : '—'}</span>
                <span>Orchestrator {afkStatus ? formatAfkOrchestrator(afkStatus.orchestrator) : '—'}</span>
                <span>末次 inject {formatAfkLastInject(afkStatus?.orchestrator.lastInjectAt ?? null)}</span>
                {afkStatus?.orchestrator.lastAction && (
                  <span className="truncate" title={afkStatus.orchestrator.lastAction}>
                    动作 {afkStatus.orchestrator.lastAction}
                  </span>
                )}
                {afkStatus?.paused && <span className="text-amber-300">已暂停</span>}
              </div>
              {afkStatus?.todo.pendingItems.length ? (
                <p className="mt-2 truncate text-[10px] text-hub-text-muted" title={afkStatus.todo.pendingItems.join(' · ')}>
                  下一项 TODO：{afkStatus.todo.pendingItems[0]}
                </p>
              ) : null}

              {(activeTaskGroup || subagents.length > 0) && (
                <div className="mt-3 space-y-1.5 border-l-2 border-violet-400/25 pl-3">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-hub-text-muted">Subagents</p>
                  {activeTaskGroup && (
                    <div className="rounded-md border border-hub-border/70 bg-hub-surface/40 px-2.5 py-2">
                      <div className="flex items-center gap-2">
                        <span className={clsx(
                          'h-1.5 w-1.5 rounded-full',
                          activeTaskGroup.main.status === 'offline' ? 'bg-hub-text-muted' : activeTaskGroup.main.status === 'working' ? 'bg-hub-accent' : 'bg-hub-green',
                        )} />
                        <span className="text-[10px] font-medium text-hub-text">{activeTaskGroup.main.title || activeTaskGroup.main.name}</span>
                        <span className="text-[9px] text-hub-text-muted">{statusLabel(activeTaskGroup.main.status)}</span>
                        <span className="ml-auto rounded bg-hub-border/50 px-1.5 py-0.5 text-[8px] text-hub-text-muted">MASTER</span>
                      </div>
                      {activeTaskGroup.children.map((child) => (
                        <div key={child.sessionId} className="ml-4 mt-1.5 flex items-center gap-2 border-l border-violet-400/20 pl-2">
                          <span className={clsx(
                            'h-1.5 w-1.5 rounded-full',
                            child.status === 'offline' ? 'bg-hub-text-muted' : child.status === 'working' ? 'bg-hub-accent' : 'bg-hub-green',
                          )} />
                          <span className="min-w-0 flex-1 truncate text-[10px] text-hub-text">{child.title || child.name}</span>
                          <span className="text-[9px] text-hub-text-muted">{statusLabel(child.status)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {sortedLiveSubagents.filter((agent) => agent.sessionId !== activeTaskGroup?.main.sessionId).map((agent) => (
                    <div key={agent.sessionId} className="flex items-center gap-2 rounded-md border border-hub-border/60 bg-hub-bg/40 px-2.5 py-1.5">
                      <span className={clsx(
                        'h-1.5 w-1.5 rounded-full',
                        agent.availability === 'busy' ? 'bg-hub-accent' : 'bg-hub-green',
                      )} />
                      <span className="min-w-0 flex-1 truncate text-[10px] text-hub-text">{agent.name}</span>
                      <span className={clsx(
                        'text-[9px]',
                        agent.availability === 'idle' ? 'text-hub-green' : agent.availability === 'busy' ? 'text-hub-accent' : 'text-hub-text-muted',
                      )}>
                        {agent.availability}
                      </span>
                      {agent.activeTask?.progress && (
                        <span className="text-[9px] text-hub-text-muted">
                          {agent.activeTask.progress.percent ?? '?'}%
                        </span>
                      )}
                    </div>
                  ))}
                  {sortedOfflineSubagents.length > 0 && (
                    <div className="border-t border-hub-border/40 pt-1">
                      <button
                        type="button"
                        onClick={() => setOfflineNowSubagentsExpanded((current) => !current)}
                        className="flex w-full items-center gap-2 py-0.5 text-left text-[9px] font-semibold uppercase tracking-[0.12em] text-hub-text-muted hover:text-hub-text"
                      >
                        <span>{offlineNowSubagentsExpanded ? '▾' : '▸'}</span>
                        <span>Offline ({sortedOfflineSubagents.length})</span>
                      </button>
                      {offlineNowSubagentsExpanded && (
                        <div className="mt-1 space-y-1 opacity-80">
                          {sortedOfflineSubagents.filter((agent) => agent.sessionId !== activeTaskGroup?.main.sessionId).map((agent) => (
                            <div key={agent.sessionId} className="flex items-center gap-2 rounded-md border border-hub-border/60 bg-hub-bg/40 px-2.5 py-1.5">
                              <span className="h-1.5 w-1.5 rounded-full bg-hub-text-muted" />
                              <span className="min-w-0 flex-1 truncate text-[10px] text-hub-text">{agent.name}</span>
                              <span className="text-[9px] text-hub-text-muted">{agent.availability}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {secondaryNowSummaries.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-hub-border/60 pt-2">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-hub-text-muted">Other active tasks</p>
                  {secondaryNowSummaries.map((summary) => (
                    <div key={summary.task_id} className="flex flex-wrap items-center gap-2 rounded-md border border-hub-border/60 px-2 py-1.5 font-mono text-[9px] text-hub-text-muted">
                      <span className="text-hub-text">{summary.task_id}</span>
                      <span className={clsx('rounded border px-1.5 py-0.5', afkTaskStatusTone(summary.status))}>
                        {formatAfkTaskStatusLabel(summary.status)}
                      </span>
                      {summary.current_unit && <span>unit {summary.current_unit}</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-hub-text-muted">无活跃 AFK 任务 · 轮次 {afkStatus?.loopCount ?? 0}/{afkStatus?.maxLoops ?? 40}</p>
          )}

          {humanReviewSummaries.map((summary) => (
            <AfkPermissionReviewCard
              key={summary.task_id}
              summary={summary}
              busy={grantBusy || afkBusy}
              onGrant={(taskId, paths) => void grantTemporaryPaths(taskId, paths)}
            />
          ))}

          {afkInfo && (
            <p className="mt-1.5 text-[10px] text-hub-green">{afkInfo}</p>
          )}

          {(historyAfkSummaries.length > 0 || afkReport.length > 0) && (
            <div className="mt-3 border-t border-hub-border/60 pt-2">
              <button
                type="button"
                onClick={() => setHistoryExpanded((current) => !current)}
                className="flex w-full items-center gap-2 text-left text-[9px] font-semibold uppercase tracking-[0.14em] text-hub-text-muted hover:text-hub-text"
              >
                <span>{historyExpanded ? '▾' : '▸'}</span>
                <span>HISTORY ({historyAfkSummaries.length + afkReport.length})</span>
              </button>
              {historyExpanded && (
                <div className="mt-2 space-y-2">
                  {historyAfkSummaries.map((summary) => (
                    <div key={summary.task_id} className="rounded-md border border-hub-border/60 bg-hub-bg/40 px-2.5 py-2">
                      <div className="flex flex-wrap items-center gap-2 font-mono text-[9px]">
                        <span className="text-hub-text">{summary.task_id}</span>
                        <span className={clsx('rounded border px-1.5 py-0.5', afkTaskStatusTone(summary.status))}>
                          {formatAfkTaskStatusLabel(summary.status)}
                        </span>
                        {summary.current_unit && <span className="text-hub-text-muted">unit {summary.current_unit}</span>}
                        <span className="text-hub-text-muted">{summary.updated_at}</span>
                      </div>
                    </div>
                  ))}
                  {afkReport.map((item) => (
                    <div key={item.taskId} className="rounded-md border border-hub-border/60 bg-hub-bg/40 px-2.5 py-2">
                      <div className="flex items-center gap-2 text-[9px]">
                        <span className="font-mono text-hub-text">{item.taskId}</span>
                        <span className="text-hub-text-muted">DECISION · {item.lineCount} lines</span>
                      </div>
                      <p className="mt-1 line-clamp-2 font-mono text-[9px] leading-4 text-hub-text-muted" title={item.excerpt}>
                        {item.excerpt}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div ref={transcriptRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          {detail?.history.map((message) => (
            <MessageBubble
              key={message.msgId}
              message={message}
              onAnnotate={beginAnnotate}
              onSuggestionClick={applySuggestion}
            />
          ))}
          {!detail?.history.length && (
            <div className="mx-auto mt-20 max-w-md text-center text-xs leading-6 text-hub-text-muted">
              点击右侧「启动 Cursor Agent」，Hub 会调用本机 <code className="text-cyan-300">cursor agent</code> CLI 自动接通 rr-chat。
              接通后从这里发送任务；选中助手回复文字可添加批注。
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-hub-border bg-hub-bg/95 p-4">
          {selected && !selected.online && (
            <div className="mb-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-[10px] leading-5 text-amber-200">
              当前会话<strong className="font-semibold">离线</strong>
              {selected.pendingMessages > 0 ? ` · ${selected.pendingMessages} 条消息已排队` : ''}
              。请点右侧「启动 Cursor Agent」；接通后会自动投递 inbox 中的任务。
            </div>
          )}
          {error && (
            <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[10px] text-red-300">{error}</div>
          )}

          {annotating && (
            <div
              ref={annPopoverRef}
              className="mb-3 rounded-xl border border-hub-accent/50 bg-hub-surface p-3 shadow-lg"
            >
              <p className="mb-2 line-clamp-2 text-[11px] text-hub-text-muted">
                批注原文：「{annotating.text}」
              </p>
              <textarea
                autoFocus
                value={annotationNote}
                onChange={(event) => setAnnotationNote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setAnnotating(null)
                    setAnnotationNote('')
                  }
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    addAnnotation()
                  }
                }}
                placeholder="写下你的批注... (⌘/Ctrl+Enter 添加, Esc 取消)"
                className="min-h-16 w-full resize-none rounded-lg border border-hub-border bg-hub-bg px-3 py-2 text-sm outline-none focus:border-cyan-400/45"
              />
              <div className="mt-2 flex justify-end gap-2">
                <button
                  onClick={() => { setAnnotating(null); setAnnotationNote('') }}
                  className="rounded-lg border border-hub-border px-3 py-1.5 text-[10px] text-hub-text-muted"
                >
                  取消
                </button>
                <button
                  disabled={!annotationNote.trim()}
                  onClick={addAnnotation}
                  className="rounded-lg bg-hub-accent-bg px-3 py-1.5 text-[10px] text-white disabled:opacity-35"
                >
                  添加批注
                </button>
              </div>
            </div>
          )}

          {annotations.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {annotations.map((item, index) => (
                <span
                  key={item.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2 py-1 text-[10px] text-cyan-200"
                >
                  <span className="shrink-0 font-semibold">#{index + 1}</span>
                  <span className="truncate">「{item.text.slice(0, 24)}{item.text.length > 24 ? '…' : ''}」→ {item.note}</span>
                  <button
                    onClick={() => removeAnnotation(item.id)}
                    className="shrink-0 text-hub-text-muted hover:text-red-300"
                    title="移除批注"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2 rounded-xl border border-hub-border bg-hub-surface p-2 focus-within:border-cyan-400/45">
            <textarea
              ref={draftRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void send()
                }
              }}
              disabled={!selected}
              placeholder="向当前 Rr 会话发送任务 · ⌘/Ctrl+Enter · 选中回复可批注"
              className="min-h-20 flex-1 resize-none bg-transparent px-2 py-1 text-sm outline-none placeholder:text-hub-text-muted disabled:opacity-40"
            />
            <button
              onClick={() => void send()}
              disabled={!canSend}
              className="self-end rounded-lg bg-hub-accent-bg px-4 py-2 text-xs text-white disabled:opacity-35"
            >
              发送
            </button>
          </div>
        </div>
      </main>

      {/* 右栏：独立滚动 */}
      <aside className="flex h-full w-80 shrink-0 flex-col overflow-hidden border-l border-hub-border bg-hub-surface/60">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <section className="rounded-xl border border-hub-border bg-hub-bg/60 p-4">
            <h3 className="text-xs font-semibold">本地接入</h3>
            <p className="mt-2 text-[10px] leading-5 text-hub-text-muted">MCP：rr-chat<br />数据：~/.rr-cursor/chat{defaultWorkspace && (<><br />workspace：{defaultWorkspace}</>)}</p>
            <button
              onClick={() => void spawnCursor()}
              disabled={!selected || busy}
              className="mt-3 w-full rounded-lg border border-cyan-400/35 bg-cyan-400/10 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-400/15 disabled:opacity-35"
            >
              启动 Cursor Agent
            </button>
            {spawnInfo && <p className="mt-2 text-[10px] leading-5 text-hub-green">{spawnInfo}</p>}
            {spawnBatch && spawnBatch.status === 'running' && (
              <div className="mt-2 space-y-1">
                {spawnBatch.jobs.map((job) => (
                  <div key={job.jobId} className="flex items-center justify-between gap-2 text-[9px] text-hub-text-muted">
                    <span className="truncate">{job.label}</span>
                    <span className={clsx(
                      job.status === 'done' && 'text-hub-green',
                      job.status === 'failed' && 'text-red-300',
                      (job.status === 'spawning' || job.status === 'waiting_online') && 'text-cyan-300',
                    )}>
                      {job.status === 'pending' && '排队'}
                      {job.status === 'spawning' && 'spawn'}
                      {job.status === 'waiting_online' && '等接通'}
                      {job.status === 'done' && (job.online === false ? '已 spawn·未接通' : '完成')}
                      {job.status === 'failed' && '失败'}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => void copyPrompt()}
              disabled={!selected}
              className="mt-2 w-full rounded-lg border border-hub-border py-1.5 text-[10px] text-hub-text-muted hover:bg-hub-border/30 disabled:opacity-35"
            >
              {copied ? '已复制 Prompt' : '复制 Prompt（兜底）'}
            </button>
          </section>

          {selected && (
            <section className="rounded-xl border border-hub-border bg-hub-bg/60 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-semibold">子 Agent</h3>
                  <p className="mt-1 text-[9px] text-hub-text-muted">动态加入本机调度池</p>
                </div>
                <button
                  onClick={() => void toggleSubagent()}
                  disabled={busy}
                  className={clsx('relative h-6 w-11 rounded-full transition-colors', selected.isSubagent ? 'bg-violet-500' : 'bg-hub-border')}
                >
                  <span className={clsx('absolute left-1 top-1 h-4 w-4 rounded-full bg-white transition-transform', selected.isSubagent && 'translate-x-5')} />
                </button>
              </div>
              {selected.activeTask && (
                <div className="mt-3 rounded-lg border border-hub-accent/30 bg-hub-accent/5 p-3">
                  <div className="font-mono text-[9px] text-hub-accent">{selected.activeTask.taskId}</div>
                  <p className="mt-2 line-clamp-3 text-[10px] leading-5 text-hub-text-muted">{selected.activeTask.content}</p>
                  {selected.activeTask.progress && (
                    <div className="mt-2 text-[10px] text-cyan-300">
                      {selected.activeTask.progress.percent ?? '?'}% · {selected.activeTask.progress.text}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          <section>
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-hub-text-muted">可调度会话</h3>
            <div className="space-y-2">
              {sortedLiveSubagents.length > 0 && (
                <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-hub-text-muted">
                  Living ({sortedLiveSubagents.length})
                </p>
              )}
              {sortedLiveSubagents.map((agent) => (
                <div key={agent.sessionId} className="rounded-lg border border-hub-border bg-hub-bg/50 p-3">
                  <div className="flex items-center gap-2">
                    <span className={clsx(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      agent.availability === 'busy' ? 'bg-hub-accent' : 'bg-hub-green',
                    )} />
                    <strong className="min-w-0 flex-1 truncate text-[11px]">{agent.name}</strong>
                    <span className={clsx(
                      'text-[9px]',
                      agent.availability === 'idle' ? 'text-hub-green' : agent.availability === 'busy' ? 'text-hub-accent' : 'text-hub-text-muted',
                    )}>
                      {agent.availability}
                    </span>
                  </div>
                  {agent.activeTask?.progress && (
                    <p className="mt-2 text-[9px] text-hub-text-muted">
                      {agent.activeTask.progress.percent ?? '?'}% · {agent.activeTask.progress.text}
                    </p>
                  )}
                </div>
              ))}
              {sortedOfflineSubagents.length > 0 && (
                <div className="border-t border-hub-border/60 pt-2">
                  <button
                    type="button"
                    onClick={() => setOfflineDispatchSubagentsExpanded((current) => !current)}
                    className="flex w-full items-center gap-2 px-1 py-1 text-left text-[9px] font-semibold uppercase tracking-[0.14em] text-hub-text-muted hover:text-hub-text"
                  >
                    <span>{offlineDispatchSubagentsExpanded ? '▾' : '▸'}</span>
                    <span>Offline ({sortedOfflineSubagents.length})</span>
                  </button>
                  {offlineDispatchSubagentsExpanded && (
                    <div className="mt-1 space-y-2 opacity-80">
                      {sortedOfflineSubagents.map((agent) => (
                        <div key={agent.sessionId} className="rounded-lg border border-hub-border bg-hub-bg/50 p-3">
                          <div className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-hub-text-muted" />
                            <strong className="min-w-0 flex-1 truncate text-[11px]">{agent.name}</strong>
                            <span className="text-[9px] text-hub-text-muted">{agent.availability}</span>
                          </div>
                          {agent.activeTask?.progress && (
                            <p className="mt-2 text-[9px] text-hub-text-muted">
                              {agent.activeTask.progress.percent ?? '?'}% · {agent.activeTask.progress.text}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {subagents.length === 0 && (
                <p className="text-[10px] leading-5 text-hub-text-muted">其他会话打开“子 Agent”开关后会出现在这里。</p>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  )
}

function MessageBubble({
  message,
  onAnnotate,
  onSuggestionClick,
}: {
  message: RrMessage
  onAnnotate: (messageId: string, text: string) => void
  onSuggestionClick: (text: string) => void
}) {
  const assistant = message.role === 'assistant'
  const contentRef = useRef<HTMLDivElement>(null)
  const suggestions = assistant && Array.isArray(message.metadata?.suggestions)
    ? message.metadata.suggestions.filter((value): value is string => typeof value === 'string')
    : []

  const handleMouseUp = () => {
    if (!assistant || !contentRef.current) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!contentRef.current.contains(range.commonAncestorContainer)) return
    const text = selection.toString().trim()
    if (text) onAnnotate(message.msgId, text)
  }

  return (
    <article className={clsx('flex', assistant ? 'justify-start' : 'justify-end')}>
      <div className={clsx(
        'max-w-[85%] rounded-2xl border px-4 py-3',
        assistant ? 'rounded-tl-sm border-hub-border bg-hub-surface' : 'rounded-tr-sm border-hub-accent/30 bg-hub-accent-bg/20',
      )}>
        <div className="mb-2 flex items-center gap-2 text-[9px] uppercase tracking-[0.15em] text-hub-text-muted">
          <span>{assistant ? 'Rr Agent' : message.role === 'system' ? 'Rr System' : 'You'}</span>
          <time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time>
          {assistant && <span className="normal-case tracking-normal text-hub-text-muted/70">选中文字可批注</span>}
        </div>
        <div
          ref={contentRef}
          onMouseUp={handleMouseUp}
          className="markdown-body text-sm"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
        />
        {suggestions.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-hub-border/70 pt-3">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onSuggestionClick(suggestion)}
                title="填入下方输入框"
                className="rounded-lg border border-hub-accent/35 px-2.5 py-1.5 text-left text-[10px] text-hub-accent transition-colors hover:border-hub-accent hover:bg-hub-accent/10"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}
