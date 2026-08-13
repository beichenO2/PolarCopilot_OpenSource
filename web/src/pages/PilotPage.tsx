import { useEffect, useState, useCallback } from 'react'
import { clsx } from 'clsx'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'
import type { LobsterState, LobsterStatus, LobsterEvent, PilotStatusSummary } from '../types/pilot-status'

const STATE_STYLE: Record<LobsterState, { bg: string; text: string; border: string }> = {
  active: { bg: 'bg-[#1f3d2b]', text: 'text-hub-green', border: 'border-hub-green/40' },
  dormant: { bg: 'bg-hub-surface', text: 'text-hub-text-muted', border: 'border-hub-border' },
  failed: { bg: 'bg-[#3d1f1f]', text: 'text-hub-red', border: 'border-hub-red/40' },
  offline: { bg: 'bg-hub-surface', text: 'text-[#484f58]', border: 'border-hub-border/50' },
}

const STATE_LABEL: Record<LobsterState, string> = {
  active: '活跃',
  dormant: '休眠',
  failed: '失败',
  offline: '离线',
}

const SEVERITY_STYLE: Record<string, string> = {
  info: 'text-hub-accent',
  warn: 'text-[#d29922]',
  error: 'text-hub-red',
}

function StateBadge({ state }: { state: LobsterState }) {
  const s = STATE_STYLE[state] ?? STATE_STYLE.offline
  return (
    <span className={clsx('text-[0.65rem] px-2 py-0.5 rounded uppercase font-semibold border', s.bg, s.text, s.border)}>
      {STATE_LABEL[state] ?? state}
    </span>
  )
}

function StatusIndicator({ state }: { state: LobsterState }) {
  const color = state === 'active' ? 'bg-hub-green shadow-[0_0_4px_theme(colors.hub.green)]'
    : state === 'failed' ? 'bg-hub-red shadow-[0_0_4px_theme(colors.hub.red)]'
    : state === 'dormant' ? 'bg-[#484f58]'
    : 'bg-[#30363d]'
  return <span className={clsx('inline-block w-2 h-2 rounded-full shrink-0', color)} />
}

function ProjectCard({ project, onClick }: { project: LobsterStatus; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="bg-hub-surface border border-hub-border rounded-xl p-4 cursor-pointer hover:border-hub-accent transition-colors"
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2">
          <StatusIndicator state={project.state} />
          <span className="font-semibold text-[#e6edf3]">{project.project_name}</span>
        </div>
        <StateBadge state={project.state} />
      </div>

      {project.current_node && (
        <div className="text-xs text-hub-text-muted mb-2">
          当前节点: <span className="text-hub-accent">{project.current_node}</span>
        </div>
      )}

      <div className="flex gap-3 text-[0.65rem] text-[#484f58]">
        <span>靶子: {project.active_targets}</span>
        {project.last_active_at && <span>活跃: {timeAgo(project.last_active_at)}</span>}
        {project.uptime_ms != null && project.uptime_ms > 0 && (
          <span>运行: {formatDuration(project.uptime_ms)}</span>
        )}
      </div>

      {project.error && (
        <div className="mt-2 text-xs text-hub-red truncate" title={project.error}>
          {project.error}
        </div>
      )}
    </div>
  )
}

function EventRow({ event }: { event: LobsterEvent }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-hub-border/30 last:border-0">
      <span className={clsx('text-xs font-mono mt-0.5 shrink-0', SEVERITY_STYLE[event.severity] ?? SEVERITY_STYLE.info)}>
        {event.severity.toUpperCase().padEnd(5)}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm truncate">{event.description}</div>
        <div className="flex gap-3 text-[0.65rem] text-[#484f58] mt-0.5">
          <span>{event.source_project}</span>
          {event.target_project && <span>→ {event.target_project}</span>}
          <span>{event.type}</span>
        </div>
      </div>
      <span className="text-[0.65rem] text-[#484f58] shrink-0">{timeAgo(event.timestamp)}</span>
    </div>
  )
}

function ConnectivityBanner({ reachable }: { reachable: boolean }) {
  if (reachable) return null
  return (
    <div className="bg-[#3d2e1f] border border-[#d29922]/40 rounded-lg px-4 py-3 flex items-center gap-3">
      <span className="text-[#d29922] text-sm font-medium">PolarClaw SDK 不可达</span>
      <span className="text-xs text-[#d29922]/70">
        所有项目显示为离线状态。SDK 就绪后将自动恢复。请检查 PolarClaw 服务是否运行。
      </span>
    </div>
  )
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function ProjectDetail({ project, events, onBack }: {
  project: LobsterStatus
  events: LobsterEvent[]
  onBack: () => void
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="px-3 py-1.5 text-sm rounded-md border border-hub-border text-hub-text-muted hover:border-hub-accent hover:text-hub-accent transition-colors"
        >
          ← 返回
        </button>
        <StatusIndicator state={project.state} />
        <h2 className="text-lg font-semibold">{project.project_name}</h2>
        <StateBadge state={project.state} />
      </div>

      <div className="bg-hub-surface border border-hub-border rounded-xl p-4 space-y-2">
        {([
          ['项目 ID', project.project_id],
          ['状态', STATE_LABEL[project.state] ?? project.state],
          ['当前节点', project.current_node || '—'],
          ['活跃靶子', String(project.active_targets)],
          ['最近活跃', project.last_active_at ? `${new Date(project.last_active_at).toLocaleString()} (${timeAgo(project.last_active_at)})` : '—'],
          ['运行时长', project.uptime_ms != null && project.uptime_ms > 0 ? formatDuration(project.uptime_ms) : '—'],
        ] as const).map(([label, val]) => (
          <div key={label} className="flex gap-3 py-1.5 border-b border-hub-border/50 last:border-0 text-sm">
            <span className="text-hub-text-muted min-w-[100px] shrink-0">{label}</span>
            <span className="break-words">{val}</span>
          </div>
        ))}
      </div>

      {project.error && (
        <div className="bg-[#3d1f1f] border border-hub-red/40 rounded-lg px-4 py-3">
          <div className="text-sm text-hub-red font-medium mb-1">错误信息</div>
          <div className="text-xs text-hub-red/80 font-mono whitespace-pre-wrap">{project.error}</div>
        </div>
      )}

      <section>
        <h3 className="text-base font-semibold mb-3">
          最近事件
          <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-hub-accent-bg text-white">{events.length}</span>
        </h3>
        {events.length === 0 ? (
          <p className="text-sm text-hub-text-muted italic text-center py-8">暂无事件记录。</p>
        ) : (
          <div className="bg-hub-surface border border-hub-border rounded-xl p-4">
            {events.map(e => <EventRow key={e.id} event={e} />)}
          </div>
        )}
      </section>
    </div>
  )
}

export function PilotPage() {
  const [data, setData] = useState<PilotStatusSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [detail, setDetail] = useState<(LobsterStatus & { events: LobsterEvent[] }) | null>(null)

  const loadSummary = useCallback(async () => {
    try {
      const d = await api.pilotStatus.summary()
      setData(d)
    } catch {
      setData({
        projects: [],
        recent_events: [],
        polarclaw_reachable: false,
        last_refresh: new Date().toISOString(),
      })
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (projectId: string) => {
    try {
      const d = await api.pilotStatus.project(projectId)
      setDetail(d)
    } catch { /* keep stale detail */ }
  }, [])

  useEffect(() => {
    loadSummary()
    const iv = setInterval(loadSummary, 30_000)
    return () => clearInterval(iv)
  }, [loadSummary])

  useEffect(() => {
    if (selectedProject) loadDetail(selectedProject)
  }, [selectedProject, loadDetail])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-sm text-hub-text-muted animate-pulse">加载 Pilot 状态...</div>
      </div>
    )
  }

  if (selectedProject && detail) {
    return (
      <ProjectDetail
        project={detail}
        events={detail.events}
        onBack={() => { setSelectedProject(null); setDetail(null) }}
      />
    )
  }

  const projects = data?.projects ?? []
  const events = data?.recent_events ?? []
  const counts = {
    active: projects.filter(p => p.state === 'active').length,
    dormant: projects.filter(p => p.state === 'dormant').length,
    failed: projects.filter(p => p.state === 'failed').length,
    offline: projects.filter(p => p.state === 'offline').length,
  }

  return (
    <div className="space-y-6">
      <ConnectivityBanner reachable={data?.polarclaw_reachable ?? false} />

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold flex items-center gap-2">
          Pilot 状态
          <span className="text-xs px-2 py-0.5 rounded-full bg-hub-accent-bg text-white">{projects.length}</span>
        </h2>
        <div className="flex gap-3 text-xs text-hub-text-muted">
          {counts.active > 0 && <span className="text-hub-green">{counts.active} 活跃</span>}
          {counts.dormant > 0 && <span>{counts.dormant} 休眠</span>}
          {counts.failed > 0 && <span className="text-hub-red">{counts.failed} 失败</span>}
          {counts.offline > 0 && <span className="text-[#484f58]">{counts.offline} 离线</span>}
          {data?.last_refresh && (
            <span className="text-[#484f58]">刷新: {timeAgo(data.last_refresh)}</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
        {projects.map(p => (
          <ProjectCard
            key={p.project_id}
            project={p}
            onClick={() => setSelectedProject(p.project_id)}
          />
        ))}
        {projects.length === 0 && (
          <p className="col-span-full text-sm text-hub-text-muted italic text-center py-16">
            暂无项目龙虾数据。请确认 PolarClaw 服务与 SDK 已就绪。
          </p>
        )}
      </div>

      {events.length > 0 && (
        <section>
          <h3 className="text-base font-semibold mb-3">
            最近事件
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-hub-accent-bg text-white">{events.length}</span>
          </h3>
          <div className="bg-hub-surface border border-hub-border rounded-xl p-4">
            {events.slice(0, 20).map(e => <EventRow key={e.id} event={e} />)}
            {events.length > 20 && (
              <div className="text-xs text-hub-text-muted text-center pt-2">
                共 {events.length} 条事件，显示最近 20 条
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
