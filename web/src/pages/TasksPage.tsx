import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import type { Task } from '../types/hub'
import { clsx } from 'clsx'
import { timeAgo } from '../lib/time'

const STATUS_COLORS: Record<string, string> = {
  open: 'border-hub-yellow text-hub-yellow',
  claimed: 'border-hub-accent text-hub-accent',
  done: 'border-hub-green text-hub-green',
  blocked: 'border-hub-red text-hub-red',
  failed: 'border-hub-red text-hub-red',
  queued: 'border-hub-yellow text-hub-yellow',
  running: 'border-hub-accent text-hub-accent',
}

const STATUS_BG: Record<string, string> = {
  open: 'bg-hub-yellow/10',
  claimed: 'bg-hub-accent/10',
  done: 'bg-hub-green/10',
  blocked: 'bg-hub-red/10',
  failed: 'bg-hub-red/10',
}

interface PilotGroup {
  pilot: Task
  children: Task[]
  doneCount: number
  progress: number
}

export function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [tab, setTab] = useState<'all' | 'hub' | 'sotagent'>('all')
  const [expandedPilot, setExpandedPilot] = useState<Set<string>>(new Set())
  const [expandedTask, setExpandedTask] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.tasks.list()
      setTasks(data)
    } catch { /* ignore */ }
  }, [])

  useUiSse(useCallback(() => { refresh() }, [refresh]))

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 30000)
    return () => clearInterval(iv)
  }, [refresh])

  const hubTasks = tasks.filter(t => t.source === 'hub')
  const sotTasks = tasks.filter(t => t.source === 'sotagent')
  const filtered = tab === 'all' ? tasks : tab === 'hub' ? hubTasks : sotTasks

  const stats = {
    total: filtered.length,
    active: filtered.filter(t => ['open', 'claimed', 'queued', 'running'].includes(t.status)).length,
    done: filtered.filter(t => t.status === 'done').length,
    failed: filtered.filter(t => ['failed', 'blocked'].includes(t.status)).length,
  }

  const pilotGroups: PilotGroup[] = []
  const pilotMap = new Map<string, PilotGroup>()
  const ungrouped: Task[] = []

  for (const t of hubTasks) {
    if (t.title.startsWith('[Pilot]')) {
      const g: PilotGroup = { pilot: t, children: [], doneCount: 0, progress: 0 }
      pilotGroups.push(g)
      pilotMap.set(t.id, g)
    }
  }
  for (const t of hubTasks) {
    if (!t.title.startsWith('[Pilot]')) {
      const parent = t.parent_task_id ? pilotMap.get(t.parent_task_id) : undefined
      if (parent) {
        parent.children.push(t)
        if (t.status === 'done') parent.doneCount++
      } else {
        ungrouped.push(t)
      }
    }
  }
  for (const g of pilotGroups) {
    g.progress = g.children.length ? Math.round((g.doneCount / g.children.length) * 100) : (g.pilot.status === 'done' ? 100 : 0)
  }

  const togglePilot = (id: string) => {
    setExpandedPilot(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-hub-border pb-2">
        {(['all', 'hub', 'sotagent'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              'px-3 py-1.5 text-xs rounded-md transition-colors',
              tab === t ? 'bg-hub-accent-bg text-white' : 'text-hub-text-muted hover:text-hub-text hover:bg-hub-border/50',
            )}
          >
            {t === 'all' ? `All (${tasks.length})` : t === 'hub' ? `Pilot (${hubTasks.length})` : `SOTAgent (${sotTasks.length})`}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="flex gap-4 flex-wrap">
        {Object.entries(stats).map(([k, v]) => (
          <div key={k} className="bg-hub-surface border border-hub-border rounded-lg px-5 py-3 min-w-[90px]">
            <div className="text-xl font-bold text-hub-accent">{v}</div>
            <div className="text-xs text-hub-text-muted capitalize mt-0.5">{k}</div>
          </div>
        ))}
      </div>

      {/* Pilot groups */}
      {(tab === 'all' || tab === 'hub') && pilotGroups.length > 0 && (
        <section className="space-y-3">
          {tab === 'all' && <h3 className="text-sm text-hub-text-muted uppercase tracking-wider">Pilot Tasks</h3>}
          {pilotGroups.map(g => {
            const isOpen = expandedPilot.has(g.pilot.id)
            const statusColor = g.pilot.status === 'done' ? 'text-hub-green' : 'text-hub-yellow'
            return (
              <div key={g.pilot.id} className="bg-hub-surface border border-hub-border rounded-xl overflow-hidden">
                {/* Pilot header */}
                <div
                  className="px-4 py-3 cursor-pointer hover:bg-hub-border/20 transition-colors"
                  onClick={() => togglePilot(g.pilot.id)}
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-[0.65rem] transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                    <span className={clsx('text-xs px-2 py-0.5 rounded-full border font-medium', STATUS_COLORS[g.pilot.status])}>{g.pilot.status}</span>
                    <span className="text-sm font-medium text-hub-text flex-1">{g.pilot.title.replace('[Pilot] ', '')}</span>
                    <span className={clsx('text-xs font-mono', statusColor)}>{g.doneCount}/{g.children.length}</span>
                  </div>
                  {/* Progress bar */}
                  <div className="flex items-center gap-2 mt-2 ml-6">
                    <div className="flex-1 h-1 bg-hub-border rounded-full overflow-hidden">
                      <div
                        className={clsx('h-full rounded-full transition-all', g.progress === 100 ? 'bg-hub-green' : 'bg-hub-yellow')}
                        style={{ width: `${g.progress}%` }}
                      />
                    </div>
                    <span className="text-[0.65rem] text-hub-text-muted w-8 text-right">{g.progress}%</span>
                  </div>
                </div>

                {/* Children */}
                {isOpen && (
                  <div className="border-t border-hub-border px-4 py-2 space-y-1">
                    {g.children.map(c => (
                      <div
                        key={c.id}
                        className={clsx('flex items-center gap-3 px-3 py-2 rounded-lg text-sm cursor-pointer hover:bg-hub-border/20 transition-colors', STATUS_BG[c.status])}
                        onClick={() => setExpandedTask(expandedTask === c.id ? null : c.id)}
                      >
                        <span className={clsx('w-1.5 h-1.5 rounded-full shrink-0', c.status === 'done' ? 'bg-hub-green' : c.status === 'claimed' ? 'bg-hub-accent' : 'bg-hub-yellow')} />
                        <span className={clsx('flex-1 truncate', c.status === 'done' && 'line-through opacity-60')}>{c.title}</span>
                        <span className="text-[0.65rem] text-hub-text-muted capitalize">{c.status}</span>
                        {c.owner_agent_id && <span className="text-[0.6rem] text-hub-text-muted font-mono">{c.owner_agent_id.slice(0, 10)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}

          {ungrouped.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-xs text-hub-text-muted uppercase tracking-wider">Ungrouped</h4>
              {ungrouped.map(t => (
                <SmallTaskCard key={t.id} task={t} expanded={expandedTask === t.id} onToggle={() => setExpandedTask(expandedTask === t.id ? null : t.id)} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* SOTAgent tasks */}
      {(tab === 'all' || tab === 'sotagent') && sotTasks.length > 0 && (
        <section className="space-y-3">
          {tab === 'all' && <h3 className="text-sm text-hub-text-muted uppercase tracking-wider mt-4">Compute Tasks (SOTAgent)</h3>}
          <div className="space-y-2">
            {sotTasks.map(t => (
              <SmallTaskCard key={t.id} task={t} expanded={expandedTask === t.id} onToggle={() => setExpandedTask(expandedTask === t.id ? null : t.id)} />
            ))}
          </div>
        </section>
      )}

      {filtered.length === 0 && (
        <p className="text-sm text-hub-text-muted italic text-center py-16">No tasks</p>
      )}
    </div>
  )
}

function SmallTaskCard({ task: t, expanded, onToggle }: { task: Task; expanded: boolean; onToggle: () => void }) {
  return (
    <div
      className={clsx('bg-hub-surface border rounded-lg p-3 cursor-pointer transition-colors hover:border-[#484f58]', STATUS_COLORS[t.status] ?? 'border-hub-border')}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium truncate flex-1">{t.title}</div>
        {t.source === 'sotagent' && <span className="text-[0.6rem] px-1.5 py-0.5 rounded bg-hub-border text-hub-text-muted shrink-0">SOT</span>}
      </div>
      <div className="flex justify-between text-xs text-hub-text-muted mt-1">
        <span className="capitalize">{t.status}{t.progress_percent ? ` ${t.progress_percent}%` : ''}</span>
        <span>{timeAgo(t.created_at)}</span>
      </div>
      {expanded && (
        <div className="mt-2 pt-2 border-t border-hub-border text-xs text-hub-text-muted space-y-1 select-text" onClick={e => e.stopPropagation()}>
          {t.description && <p className="whitespace-pre-wrap break-all text-hub-text">{t.description}</p>}
          {t.task_type && <p>Type: {t.task_type}</p>}
          {t.requester && <p>Requester: {t.requester}</p>}
          {t.owner_agent_id && <p>Agent: {t.owner_agent_id}</p>}
          {t.pid && <p>PID: {t.pid}</p>}
          <p>Created: {new Date(t.created_at).toLocaleString()}</p>
        </div>
      )}
    </div>
  )
}
