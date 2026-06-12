import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import { StatusDot } from '../components/StatusDot'
import type { ServiceHealth, ProjectData, EcoService, PortEntry, DeviceResource } from '../types/hub'

type ServiceTier = 'infra' | 'knowledge' | 'app' | 'domain' | 'external'

const TIER_MAP: Record<string, ServiceTier> = {
  'polarcop-hub': 'infra',
  'privportal-backend': 'infra',
  'privportal-frontend': 'infra',
  'privportal-vault-sync': 'infra',
  'sotagent-console': 'infra',
  'tailscale-funnel-monitor': 'infra',
  'digist': 'knowledge',
  'digist-engine': 'knowledge',
  'digist-daily-digest': 'knowledge',
  'digist-summarize': 'knowledge',
  'digist-to-knowlever-sync': 'knowledge',
  'autooffice': 'app',
  'polarclock-backend': 'app',
  'polarclock-frontend': 'app',
  'polarclaw': 'app',
  'polarclaw-agent': 'app',
  'polarclaw-web': 'app',
  'ai-daily-digest': 'app',
  'claude-code-vis': 'app',
  'tqsdk-data-collector': 'domain',
}

const PORT_TIER_MAP: Record<string, ServiceTier> = {
  'Polarisor/SOTAgent': 'infra',
  'Polarisor/PolarCopilot': 'infra',
  'Polarisor/PolarPrivate': 'infra',
  'Polarisor/digist': 'knowledge',
  'Polarisor/KnowLever': 'knowledge',
  'Polarisor/AutoOffice': 'app',
  'Polarisor/Clock': 'app',
  'Polarisor/PolarClaw': 'app',
  'clawd/ai-daily-digest': 'app',
  'workplace/claude-code-vis-server': 'app',
  'Polarisor/tqsdk': 'domain',
}

const TIER_LABEL: Record<ServiceTier, string> = {
  infra: 'Infrastructure',
  knowledge: 'Knowledge Processing',
  app: 'Applications',
  domain: 'Domain Services',
  external: 'System / External',
}

const TIER_ORDER: ServiceTier[] = ['infra', 'knowledge', 'app', 'domain', 'external']

function getTier(id: string): ServiceTier {
  return TIER_MAP[id] ?? 'external'
}

function getPortTier(project: string): ServiceTier {
  return PORT_TIER_MAP[project] ?? 'external'
}

const MAX_HISTORY = 30

function statusColor(s: string) {
  if (s === 'running' || s === 'up' || s === 'active') return 'text-hub-green'
  if (s === 'stopped' || s === 'stale') return 'text-hub-text-muted'
  return 'text-hub-red'
}

function statusBg(s: string) {
  if (s === 'running' || s === 'up' || s === 'active') return 'border-[#238636] bg-[#0d1f0d]'
  if (s === 'stopped' || s === 'stale') return 'border-hub-border bg-hub-surface'
  return 'border-[#da3633] bg-[#1f0d0d]'
}

function serviceHref(svc: EcoService) {
  if (svc.url) return svc.url
  if (svc.port) return `http://localhost:${svc.port}`
  return null
}

export function DashboardPage() {
  const [coreServices, setCoreServices] = useState<ServiceHealth[]>([])
  const [ecoServices, setEcoServices] = useState<EcoService[]>([])
  const [ports, setPorts] = useState<PortEntry[]>([])
  const [project, setProject] = useState<ProjectData | null>(null)
  const [resource, setResource] = useState<DeviceResource | null>(null)
  const [cpuHistory, setCpuHistory] = useState<number[]>([])
  const [memHistory, setMemHistory] = useState<number[]>([])
  const [gpuHistory, setGpuHistory] = useState<number[]>([])
  const [updatedAt, setUpdatedAt] = useState('')

  useEffect(() => {
    let prevHealthKey = ''
    let prevSvcKey = ''
    let prevPortKey = ''
    let prevProjKey = ''
    const refreshHealth = async () => {
      try {
        const data = await api.health.check()
        if (!Array.isArray(data)) return
        const key = data.map(s => `${s.name}:${s.status}:${s.latencyMs}`).join('|')
        if (key === prevHealthKey) return
        prevHealthKey = key
        setCoreServices(data)
        setUpdatedAt(new Date().toLocaleTimeString())
      } catch { /* ignore */ }
    }
    const refreshServices = async () => {
      try {
        const data = await api.health.services()
        if (!Array.isArray(data)) return
        const key = data.map(s => `${s.id}:${s.status}:${s.pid}`).join('|')
        if (key === prevSvcKey) return
        prevSvcKey = key
        setEcoServices(data)
      } catch { /* ignore */ }
    }
    const refreshPorts = async () => {
      try {
        const data = await api.health.ports()
        if (!Array.isArray(data)) return
        const key = data.map(p => `${p.port}:${p.status}`).join('|')
        if (key === prevPortKey) return
        prevPortKey = key
        setPorts(data)
      } catch { /* ignore */ }
    }
    const refreshProject = async () => {
      try {
        const data = await api.project.get()
        if (!data) return
        const key = JSON.stringify(data)
        if (key === prevProjKey) return
        prevProjKey = key
        setProject(data)
      } catch { /* ignore */ }
    }
    const refreshResources = async () => {
      try {
        const data = await api.health.resources()
        if (data?.resource) {
          setResource(data)
          setCpuHistory(h => [...h.slice(-(MAX_HISTORY - 1)), data.resource.cpu_percent])
          setMemHistory(h => [...h.slice(-(MAX_HISTORY - 1)), data.resource.mem_percent])
          setGpuHistory(h => [...h.slice(-(MAX_HISTORY - 1)), data.resource.gpu_mem_used_mb])
        }
      } catch { /* ignore */ }
    }

    refreshHealth()
    refreshServices()
    refreshPorts()
    refreshProject()
    refreshResources()
    const iv1 = setInterval(refreshHealth, 30000)
    const iv2 = setInterval(refreshServices, 30000)
    const iv3 = setInterval(refreshPorts, 30000)
    const iv4 = setInterval(refreshProject, 30000)
    const iv5 = setInterval(refreshResources, 10000)
    return () => { clearInterval(iv1); clearInterval(iv2); clearInterval(iv3); clearInterval(iv4); clearInterval(iv5) }
  }, [])

  useUiSse(useCallback(() => {
    // SSE event triggers a refresh cycle
    api.health.check().then(d => { setCoreServices(d); setUpdatedAt(new Date().toLocaleTimeString()) }).catch(() => {})
    api.health.services().then(d => setEcoServices(d)).catch(() => {})
  }, []))

  const [toast, setToast] = useState<{ message: string; ok: boolean } | null>(null)

  const handleServiceAction = useCallback(async (id: string, action: 'start' | 'stop' | 'restart') => {
    try {
      const result = await api.services[action](id)
      setToast({ message: result.message, ok: result.ok })
      // Refresh service list after action
      setTimeout(async () => {
        try {
          const data = await api.health.services()
          if (Array.isArray(data)) setEcoServices(data)
        } catch { /* ignore */ }
      }, 1500)
    } catch (e) {
      setToast({ message: `Failed to ${action} service`, ok: false })
    }
    setTimeout(() => setToast(null), 4000)
  }, [])

  const pp = project?.polarPrivate
  const hub = project?.hub
  const ppSummary = pp?.summary
  const ppHealth = pp?.health
  const vaultUnlocked = ppHealth?.vault_unlocked as boolean | undefined

  const runningCount = ecoServices.filter(s => s.status === 'running').length
  const errorCount = ecoServices.filter(s => s.status === 'error').length
  const stoppedCount = ecoServices.filter(s => s.status === 'stopped').length
  const serviceLinks = ecoServices.filter(s => s.status === 'running' && serviceHref(s))

  const managedPorts = new Set(ecoServices.filter(s => s.port).map(s => s.port))
  const unmanagedPorts = ports.filter(p => !managedPorts.has(p.port))

  const grouped = TIER_ORDER.reduce<Record<ServiceTier, EcoService[]>>((acc, t) => {
    acc[t] = []; return acc
  }, {} as Record<ServiceTier, EcoService[]>)
  for (const svc of ecoServices) {
    grouped[getTier(svc.id)].push(svc)
  }
  for (const tier of TIER_ORDER) {
    grouped[tier].sort((a, b) => {
      const so = { running: 0, error: 1, stopped: 2 }
      return (so[a.status] ?? 9) - (so[b.status] ?? 9)
    })
  }

  const portGrouped = TIER_ORDER.reduce<Record<ServiceTier, PortEntry[]>>((acc, t) => {
    acc[t] = []; return acc
  }, {} as Record<ServiceTier, PortEntry[]>)
  for (const p of unmanagedPorts) {
    portGrouped[getPortTier(p.project)].push(p)
  }

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg text-sm font-medium shadow-lg border transition-all ${
          toast.ok
            ? 'bg-[#0d1f0d] border-[#238636] text-hub-green'
            : 'bg-[#1f0d0d] border-[#da3633] text-hub-red'
        }`}>
          {toast.message}
        </div>
      )}

      {/* System Resources */}
      {resource && (
        <section>
          <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border flex items-center justify-between">
            <span>{resource.device.hostname}</span>
            <span className="text-[0.7rem] font-normal text-hub-text-muted">
              {resource.device.platform} · {resource.device.totalMemGB}GB
            </span>
          </h2>
          <div className="grid grid-cols-3 gap-3">
            <ResourceGauge
              label="CPU"
              value={resource.resource.cpu_percent}
              max={100}
              unit="%"
              color={resource.resource.cpu_percent > 90 ? '#da3633' : resource.resource.cpu_percent > 70 ? '#d29922' : '#238636'}
              history={cpuHistory}
            />
            <ResourceGauge
              label="Memory"
              value={resource.resource.mem_percent}
              max={100}
              unit="%"
              detail={`${(resource.resource.mem_used_mb / 1024).toFixed(1)} / ${(resource.resource.mem_total_mb / 1024).toFixed(0)} GB`}
              color={resource.resource.mem_percent > 95 ? '#da3633' : resource.resource.mem_percent > 85 ? '#d29922' : '#238636'}
              history={memHistory}
            />
            <ResourceGauge
              label={resource.device.platform.includes('darwin') ? 'GPU (Unified Mem)' : 'GPU Memory'}
              value={resource.resource.gpu_mem_used_mb}
              max={resource.device.platform.includes('darwin') ? resource.device.totalMemGB * 1024 * 0.75 : 24576}
              unit="MB"
              detail={resource.device.platform.includes('darwin')
                ? `${(resource.resource.gpu_mem_used_mb / 1024).toFixed(1)} / ${(resource.device.totalMemGB * 0.75).toFixed(0)} GB (75% unified)`
                : undefined
              }
              color="#bc8cff"
              history={gpuHistory}
              historyMax={resource.device.platform.includes('darwin') ? resource.device.totalMemGB * 1024 * 0.75 : 24576}
            />
          </div>
          <div className="flex gap-4 mt-2 text-[0.7rem] text-[#484f58]">
            <span>Projects: {resource.projectCount}</span>
            <span>Assets: {resource.assetCount}</span>
            <span>Tasks: {resource.tasks.running} running · {resource.tasks.queued} queued · {resource.tasks.failed} failed</span>
          </div>
        </section>
      )}

      {/* Core Services */}
      <section>
        <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border">
          Core Services
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {coreServices.map((s) => (
            <a
              key={s.name}
              href={s.consoleUrl}
              target={s.consoleUrl.startsWith('/') ? '_self' : '_blank'}
              rel="noopener noreferrer"
              className="bg-hub-surface border border-hub-border rounded-xl p-5 hover:border-hub-accent transition-colors block no-underline text-inherit"
            >
              <div className="flex items-center gap-2.5 mb-3">
                <StatusDot alive={s.status === 'up'} />
                <span className="text-[1.1rem] font-semibold">{s.name}</span>
              </div>
              <div className="text-xs text-hub-text-muted mb-2 min-h-[1.2em]">
                {s.detail || ''}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs font-mono text-hub-accent">{s.consoleUrl}</span>
                <span className="text-xs text-hub-text-muted">{s.latencyMs}ms</span>
              </div>
            </a>
          ))}
          {coreServices.length === 0 && (
            <div className="text-hub-text-muted text-center py-8">Loading...</div>
          )}
        </div>
        {updatedAt && (
          <div className="text-right text-[0.7rem] text-[#484f58] mt-2">
            Updated {updatedAt}
          </div>
        )}
      </section>

      {/* Ecosystem Services */}
      <section>
        <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border flex items-center justify-between">
          <span>Managed Services</span>
          <span className="text-[0.75rem] font-normal text-hub-text-muted">
            {ecoServices.length} registered
          </span>
        </h2>
        <div className="flex gap-4 mb-4">
          <MiniStat label="Running" value={runningCount} color="text-hub-green" />
          <MiniStat label="Error" value={errorCount} color="text-hub-red" />
          <MiniStat label="Stopped" value={stoppedCount} color="text-hub-text-muted" />
        </div>

        {serviceLinks.length > 0 && (
          <div className="mb-4 grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-2">
            {serviceLinks.map((svc) => {
              const href = serviceHref(svc)
              if (!href) return null
              return (
                <a
                  key={svc.id}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group rounded-lg border border-[#238636] bg-[#0d1f0d] p-3 transition-colors hover:bg-[#102910] hover:border-hub-green"
                >
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-hub-green shadow-[0_0_4px] shadow-hub-green" />
                    <span className="truncate text-[0.82rem] font-semibold text-hub-text group-hover:text-white" title={svc.name}>
                      {svc.name}
                    </span>
                  </div>
                  <div className="mt-1 text-[0.68rem] text-hub-text-muted">
                    :{svc.port} · running
                  </div>
                </a>
              )
            })}
          </div>
        )}

        {TIER_ORDER.map((tier) => {
          const list = grouped[tier]
          if (list.length === 0) return null
          return (
            <div key={tier} className="mb-4">
              <h3 className="text-[0.8rem] font-semibold text-hub-text-muted uppercase tracking-wider mb-2">
                {TIER_LABEL[tier]}
              </h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                {list.map((svc) => (
                  <EcoCard key={svc.id} svc={svc} onAction={handleServiceAction} />
                ))}
              </div>
            </div>
          )
        })}
      </section>

      {/* Port Registry */}
      {unmanagedPorts.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border flex items-center justify-between">
            <span>Port Registry</span>
            <span className="text-[0.75rem] font-normal text-hub-text-muted">
              {ports.length} ports · {unmanagedPorts.length} unmanaged
            </span>
          </h2>

          {TIER_ORDER.map((tier) => {
            const list = portGrouped[tier]
            if (list.length === 0) return null
            return (
              <div key={tier} className="mb-4">
                <h3 className="text-[0.8rem] font-semibold text-hub-text-muted uppercase tracking-wider mb-2">
                  {TIER_LABEL[tier]}
                </h3>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
                  {list.map((p) => (
                    <PortCard key={p.port} port={p} />
                  ))}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* Project Overview */}
      <section>
        <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border flex items-center justify-between">
          <span>Project Overview</span>
          {vaultUnlocked !== undefined && (
            <span className={`text-[0.7rem] px-2 py-0.5 rounded-[10px] font-medium ${
              vaultUnlocked
                ? 'bg-[#0d1f0d] text-hub-green border border-[#238636]'
                : 'bg-[#1f0d0d] text-hub-red border border-[#da3633]'
            }`}>
              {vaultUnlocked ? 'Vault Unlocked' : 'Vault Locked'}
            </span>
          )}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3 mb-4">
          <StatCard label="Identities" value={ppSummary?.identity_count} color="text-hub-accent" />
          <StatCard label="Secrets" value={ppSummary?.secret_count} color="text-[#d29922]" />
          <StatCard label="Bindings" value={ppSummary?.binding_count} color="text-hub-green" />
          <StatCard label="Hub Agents" value={hub?.agents} color="text-[#bc8cff]" />
          <StatCard label="Tasks Total" value={hub?.tasks.total} color="text-hub-accent" />
          <StatCard label="Completed" value={hub?.tasks.done} color="text-hub-green" />
        </div>
      </section>

      {/* Hub Agents */}
      {hub && hub.agentList.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border">
            Hub Agents
          </h2>
          <div className="flex flex-wrap gap-2">
            {hub.agentList.map((a) => (
              <div key={a.id} className="bg-[#21262d] border border-hub-border rounded-md px-2.5 py-1 text-xs flex items-center gap-1.5">
                <span className="text-hub-accent font-semibold">{a.role}</span>
                <span className="text-hub-text-muted">{a.id.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Projects */}
      {pp?.recentProjects?.items && pp.recentProjects.items.length > 0 && (
        <section>
          <h2 className="text-base font-semibold mb-3 pb-2 border-b border-hub-border">
            Recent Projects
          </h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
            {pp.recentProjects.items.map((p) => (
              <div key={p.name} className="bg-hub-surface border border-hub-border rounded-[10px] p-3.5 hover:border-hub-accent transition-colors">
                <div className="font-semibold text-[0.95rem] mb-1">{p.name}</div>
                {p.description && <div className="text-xs text-hub-text-muted leading-tight">{p.description}</div>}
                <div className="text-[0.65rem] text-[#484f58] mt-1.5">
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function EcoCard({ svc, onAction }: { svc: EcoService; onAction: (id: string, action: 'start' | 'stop' | 'restart') => void }) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState<string | null>(null)
  const href = serviceHref(svc)

  const handleAction = async (e: React.MouseEvent, action: 'start' | 'stop' | 'restart') => {
    e.stopPropagation()
    setLoading(action)
    try {
      onAction(svc.id, action)
    } finally {
      setTimeout(() => setLoading(null), 2000)
    }
  }

  return (
    <div
      onClick={() => setExpanded(!expanded)}
      className={`border rounded-lg p-3 cursor-pointer transition-colors ${statusBg(svc.status)} hover:brightness-110`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          svc.status === 'running' ? 'bg-hub-green shadow-[0_0_4px] shadow-hub-green' :
          svc.status === 'error' ? 'bg-hub-red shadow-[0_0_4px] shadow-hub-red' :
          'bg-[#484f58]'
        }`} />
        <span className="text-[0.85rem] font-semibold truncate flex-1" title={svc.name}>{svc.name}</span>
        <span className={`text-[0.65rem] font-mono ${statusColor(svc.status)}`}>
          {svc.status}
        </span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded border border-hub-border px-1.5 py-0.5 text-[0.6rem] font-medium text-hub-accent hover:border-hub-accent hover:text-white"
          >
            Open
          </a>
        )}
      </div>
      <div className="flex items-center gap-2 text-[0.7rem] text-[#484f58]">
        {svc.port && <span className="font-mono">:{svc.port}</span>}
        {svc.pid && <span>PID {svc.pid}</span>}
        {svc.cron_schedule && <span title={svc.cron_schedule}>cron</span>}
        {svc.auto_start && svc.status !== 'running' && (
          <span className="text-hub-yellow text-[0.6rem]">auto-start</span>
        )}
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-[#21262d] text-[0.7rem] space-y-1">
          {svc.started_at && (
            <Row label="Started" value={new Date(svc.started_at).toLocaleString()} />
          )}
          {svc.last_health_check && (
            <Row label="Last check" value={new Date(svc.last_health_check).toLocaleString()} />
          )}
          {svc.restart_count > 0 && (
            <Row label="Restarts" value={`${svc.restart_count}/${svc.max_restarts}`} />
          )}
          {svc.last_exit_code !== null && (
            <Row label="Exit code" value={String(svc.last_exit_code)} />
          )}
          {svc.last_error && (
            <div className="mt-1">
              <span className="text-hub-text-muted">Error: </span>
              <span className="text-hub-red break-all">{svc.last_error.slice(0, 200)}</span>
            </div>
          )}

          <div className="flex gap-1.5 mt-2 pt-2 border-t border-[#21262d]">
            {svc.status !== 'running' && (
              <button
                onClick={(e) => handleAction(e, 'start')}
                disabled={loading !== null}
                className="flex-1 px-2 py-1 rounded text-[0.65rem] font-medium bg-[#238636] hover:bg-[#2ea043] text-white transition-colors disabled:opacity-50"
              >
                {loading === 'start' ? 'Starting...' : 'Start'}
              </button>
            )}
            {svc.status === 'running' && (
              <button
                onClick={(e) => handleAction(e, 'stop')}
                disabled={loading !== null}
                className="flex-1 px-2 py-1 rounded text-[0.65rem] font-medium bg-[#da3633] hover:bg-[#e5534b] text-white transition-colors disabled:opacity-50"
              >
                {loading === 'stop' ? 'Stopping...' : 'Stop'}
              </button>
            )}
            <button
              onClick={(e) => handleAction(e, 'restart')}
              disabled={loading !== null}
              className="flex-1 px-2 py-1 rounded text-[0.65rem] font-medium bg-[#21262d] hover:bg-[#30363d] border border-hub-border text-hub-text transition-colors disabled:opacity-50"
            >
              {loading === 'restart' ? 'Restarting...' : 'Restart'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function PortCard({ port }: { port: PortEntry }) {
  return (
    <div className={`border rounded-lg p-3 transition-colors ${statusBg(port.status)}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
          port.status === 'active' ? 'bg-hub-green shadow-[0_0_4px] shadow-hub-green' :
          'bg-[#484f58]'
        }`} />
        <span className="text-[0.85rem] font-semibold truncate flex-1" title={port.service_name}>
          {port.service_name}
        </span>
        <span className="text-[0.65rem] font-mono text-hub-accent">:{port.port}</span>
      </div>
      <div className="flex items-center gap-2 text-[0.7rem] text-[#484f58]">
        <span className="truncate" title={port.project}>{port.project}</span>
        <span className="flex-shrink-0">{port.device_id}</span>
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-hub-text-muted">{label}</span>
      <span className="text-hub-text">{value}</span>
    </div>
  )
}

function MiniStat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`text-lg font-bold font-mono ${color}`}>{value}</span>
      <span className="text-[0.75rem] text-hub-text-muted">{label}</span>
    </div>
  )
}

function ResourceGauge({ label, value, max, unit, color, detail, history, historyMax }: {
  label: string; value: number; max: number; unit: string; color: string; detail?: string
  history: number[]; historyMax?: number
}) {
  const pct = Math.min(100, (value / max) * 100)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || history.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    const hMax = historyMax ?? max
    ctx.clearRect(0, 0, w, h)
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.globalAlpha = 0.6
    ctx.beginPath()
    for (let i = 0; i < history.length; i++) {
      const x = (i / (MAX_HISTORY - 1)) * w
      const y = h - (Math.min(history[i] ?? 0, hMax) / hMax) * h
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.stroke()
    ctx.globalAlpha = 0.08
    ctx.lineTo(w, h)
    ctx.lineTo(0, h)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }, [history, color, max, historyMax])

  return (
    <div className="bg-hub-surface border border-hub-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[0.8rem] text-hub-text-muted">{label}</span>
        <span className="text-lg font-bold font-mono" style={{ color }}>
          {typeof value === 'number' ? (value % 1 === 0 ? value : value.toFixed(1)) : '—'}{unit}
        </span>
      </div>
      <div className="w-full h-1.5 bg-[#21262d] rounded-full mb-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <canvas ref={canvasRef} width={200} height={40} className="w-full h-[40px] rounded" />
      {detail && <div className="text-[0.65rem] text-[#484f58] mt-1 text-right">{detail}</div>}
    </div>
  )
}

function StatCard({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <div className="bg-hub-surface border border-hub-border rounded-[10px] p-4 text-center">
      <div className={`text-[1.6rem] font-bold font-mono ${color}`}>
        {value ?? '—'}
      </div>
      <div className="text-xs text-hub-text-muted mt-1">{label}</div>
    </div>
  )
}
