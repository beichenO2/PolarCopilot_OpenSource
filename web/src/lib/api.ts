import type { Agent, Prompt, HubEvent, Task, AgentsSummary, ServiceHealth, ProjectData, EcoService, PortEntry, DeviceResource } from '../types/hub'
import type { PilotStatusSummary, LobsterStatus, LobsterEvent } from '../types/pilot-status'

export interface EvolutionSignal {
  id: string
  type: string
  source: string
  agentId?: string
  title: string
  details: string
  context?: Record<string, unknown>
  createdAt: string
}

export interface EvolutionGene {
  id: string
  category: 'repair' | 'optimize' | 'innovate'
  title: string
  signalsMatch: string[]
  strategy: string[]
  validation: string[]
  constraints: { maxFiles?: number; forbiddenPaths?: string[] }
  successCount: number
  failureCount: number
  createdAt: string
  updatedAt: string
}

export interface EvolutionSuggestion {
  id: string
  geneId: string
  signalIds: string[]
  status: 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed'
  title: string
  analysis: string
  proposedChange: string
  blastRadius: { files: number; lines: number }
  agentId?: string
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  resolvedBy?: string
  rejectReason?: string
}

export interface EvolutionStats {
  signals: { total: number; unprocessed: number; byType: Record<string, number> }
  genes: { total: number; byCategory: Record<string, number> }
  suggestions: { total: number; pending: number; approved: number; rejected: number; done: number }
}

export interface ProlusionPlanSummary {
  id: string
  title: string
  goal: string
  status: string
  current_stage: number
  ssot_refs: string[]
  created_by: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface ProlusionDemandAnalysis {
  objectives?: string[]
  scope?: string
  constraints?: string[]
  success_criteria?: string[]
  notes?: string
}

export interface ProlusionCodeMapping {
  relevant_files?: Array<{ path: string; role: string }>
  modules?: Array<{ name: string; description: string; files: string[] }>
  dependencies?: string[]
  notes?: string
}

export interface ProlusionTechOverview {
  stack?: Array<{ name: string; version?: string; role: string }>
  risks?: Array<{ description: string; severity: 'low' | 'medium' | 'high'; mitigation?: string }>
  decisions?: Array<{ question: string; choice: string; rationale: string }>
  notes?: string
}

export interface ProlusionTaskItem {
  title: string
  description: string
  agent_type?: string
  priority?: number
  depends_on?: string[]
  module?: string
}

export interface ProlusionPlan extends ProlusionPlanSummary {
  demand_analysis: ProlusionDemandAnalysis
  code_mapping: ProlusionCodeMapping
  tech_overview: ProlusionTechOverview
  task_allocation: ProlusionTaskItem[]
}

export interface AlignmentSection {
  name: string
  confirmed: boolean
  comment?: string
}

export interface AlignmentWorkflow {
  name: string
  steps: string[]
  priority: 'critical' | 'normal' | 'low'
  test_type: 'cli' | 'computer_use' | 'both'
}

export interface AlignmentDoc {
  id: string
  agent_id: string
  status: 'draft' | 'pending_review' | 'approved' | 'rejected' | 'executing' | 'completed'
  goal: string
  work_logic: string
  workflows: AlignmentWorkflow[]
  plan_markdown: string
  sections: AlignmentSection[] | null
  version: number
  pilot_project_id: string | null
  created_at: string
  updated_at: string
  approved_at: string | null
  completed_at: string | null
}

export interface AlignmentVersion {
  id: string
  version: number
  plan_markdown: string
  sections: AlignmentSection[] | null
  changed_by: string
  created_at: string
}

const BASE = ''

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: 'no-store' })
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let detail = ''
    try { const j = await res.json(); detail = j.error || j.message || '' } catch { /* no json body */ }
    throw new Error(detail || `POST ${path}: ${res.status}`)
  }
  return res.json() as Promise<T>
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`PATCH ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

async function del2<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`DELETE ${path}: ${res.status}`)
  return res.json() as Promise<T>
}

export interface PolarisFeature {
  name: string
  status: 'done' | 'in-progress' | 'planned' | 'blocked'
  description?: string
  tech?: string[]
  interfaces?: string[]
  behavior?: string[]
  depends_on?: string[]
}

export interface PolarisRequirement {
  id: string
  need: string
  approach: string
  technical_details?: string
  tech?: Record<string, string>
  features: PolarisFeature[]
  blockers: string[]
}

export interface PolarisProject {
  name: string
  description: string
  tier: string
  status: string
  version?: string
  repository?: string
  tech?: Record<string, Record<string, string>>
  ports?: Record<string, { port: number; protocol: string; description: string }>
  requirements: PolarisRequirement[]
  depends_on: string[]
  depended_by: string[]
  contacts?: { owner?: string; last_updated?: string; updated_by?: string }
  _file?: string
  _mtime?: number
}

export interface SSOTAnnotation {
  id: string
  project: string
  field_path: string
  author: string
  author_type: 'user' | 'agent'
  text: string
  parent_id: string | null
  created_at: number
}

export const api = {
  agents: {
    list: () => get<Agent[]>('/api/ui/agents'),
    summary: () => get<AgentsSummary>('/api/ui/agents/summary'),
    update: (id: string, data: Partial<Pick<Agent, 'display_name' | 'agent_type' | 'parent_agent_id'>>) =>
      patch<{ ok: boolean }>(`/api/ui/agents/${id}`, data),
    remove: (id: string) => del<{ ok: boolean }>(`/api/ui/agents/${id}`),
    purgeDead: () => del<{ ok: boolean; purged: number }>('/api/ui/agents/dead'),
  },

  prompts: {
    pending: () => get<Prompt[]>('/api/ui/prompts'),
    history: (limit = 200) => get<Prompt[]>(`/api/ui/prompts/history?limit=${limit}`),
    get: (id: string) => get<Prompt>(`/api/ui/prompts/${id}`),
    answer: (id: string, answer: string) =>
      post<{ id: string; answer: string; state: string }>(`/api/ui/prompts/${id}/answer`, { answer }),
  },

  events: {
    list: (agentId?: string, limit = 50) => {
      const params = new URLSearchParams()
      if (agentId) params.set('agent_id', agentId)
      params.set('limit', String(limit))
      return get<HubEvent[]>(`/api/ui/events?${params}`)
    },
  },

  checkup: {
    list: (limit = 50) => get<{
      ok: boolean
      count: number
      stats: Record<'pending' | 'processing' | 'resolved' | 'needs_human', number>
      events: Array<{
        event_id: string
        project: string
        page_url: string
        user_text: string
        timestamp: string
        received_at?: string
        status: 'pending' | 'processing' | 'resolved' | 'needs_human'
        summary?: string
        handler?: string
      }>
    }>(`/api/ui/checkup-events?limit=${limit}`),
    status: (eventId: string) => get<{ ok: boolean; event: Record<string, unknown> }>(
      `/api/ui/checkup-events/${encodeURIComponent(eventId)}/status`,
    ),
  },

  tasks: {
    list: async (): Promise<Task[]> => {
      const data = await get<{ tasks: Task[]; waves: Record<string, number> }>('/api/ui/tasks')
      const waves = data.waves ?? {}
      return (data.tasks ?? []).map((t) => ({ ...t, wave: waves[t.id] ?? t.wave ?? 0 }))
    },
  },

  health: {
    check: () => get<ServiceHealth[]>('/api/ui/health'),
    hub: () => get<{ status: string; service: string; uptime: number }>('/api/health'),
    services: () => get<EcoService[]>('/api/ui/services'),
    ports: () => get<PortEntry[]>('/api/ui/ports'),
    resources: () => get<DeviceResource>('/api/ui/resources'),
  },

  services: {
    start: (id: string) => post<{ ok: boolean; message: string; pid?: number }>(`/api/ui/services/${id}/start`),
    stop: (id: string) => post<{ ok: boolean; message: string }>(`/api/ui/services/${id}/stop`),
    restart: (id: string) => post<{ ok: boolean; message: string; pid?: number }>(`/api/ui/services/${id}/restart`),
  },

  project: {
    get: () => get<ProjectData>('/api/ui/project'),
  },

  evolution: {
    signals: (opts?: { unprocessed?: boolean; limit?: number }) => {
      const params = new URLSearchParams()
      if (opts?.unprocessed) params.set('unprocessed', 'true')
      if (opts?.limit) params.set('limit', String(opts.limit))
      return get<EvolutionSignal[]>(`/api/evolution/signals?${params}`)
    },
    submitSignal: (data: { type: string; source: string; agent_id?: string; title: string; details: string; context?: Record<string, unknown> }) =>
      post<{ ok: boolean; signal: EvolutionSignal }>('/api/evolution/signals', data),
    genes: () => get<EvolutionGene[]>('/api/evolution/genes'),
    matchGenes: (signalTypes: string[]) =>
      post<EvolutionGene[]>('/api/evolution/genes/match', { signal_types: signalTypes }),
    suggestions: (status?: string, limit = 50) => {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      params.set('limit', String(limit))
      return get<EvolutionSuggestion[]>(`/api/evolution/suggestions?${params}`)
    },
    getSuggestion: (id: string) => get<EvolutionSuggestion>(`/api/evolution/suggestions/${id}`),
    createSuggestion: (data: { gene_id: string; signal_ids?: string[]; title: string; analysis: string; proposed_change: string; blast_radius?: { files: number; lines: number } }) =>
      post<{ ok: boolean; suggestion: EvolutionSuggestion }>('/api/evolution/suggestions', data),
    approveSuggestion: (id: string) =>
      post<{ ok: boolean; suggestion: EvolutionSuggestion }>(`/api/evolution/suggestions/${id}/approve`, { by: 'user' }),
    rejectSuggestion: (id: string, reason: string) =>
      post<{ ok: boolean; suggestion: EvolutionSuggestion }>(`/api/evolution/suggestions/${id}/reject`, { reason, by: 'user' }),
    stats: () => get<EvolutionStats>('/api/evolution/stats'),
  },

  polaris: {
    list: () => get<{ projects: PolarisProject[]; total: number }>('/api/polaris'),
    get: (project: string) => get<PolarisProject>(`/api/polaris/${project}`),
    update: (project: string, data: Record<string, unknown>) =>
      patch<{ ok: boolean; updated: string[] }>(`/api/polaris/${project}`, data),
    annotations: (project: string) => get<{ annotations: SSOTAnnotation[] }>(`/api/polaris/${project}/annotations`),
    annotate: (project: string, data: { field_path: string; author: string; author_type?: string; text: string; parent_id?: string }) =>
      post<{ ok: boolean; id: string; created_at: number }>(`/api/polaris/${project}/annotations`, data),
    deleteAnnotation: (project: string, id: string) =>
      del<{ ok: boolean }>(`/api/polaris/${project}/annotations/${id}`),
    deleteAnnotationsByFields: (project: string, fieldPaths: string[]) =>
      del2<{ ok: boolean }>(`/api/polaris/${project}/annotations`, { field_paths: fieldPaths }),
  },

  prolusion: {
    list: () => get<ProlusionPlanSummary[]>('/api/ui/prolusion'),
    get: (id: string) => get<ProlusionPlan>(`/api/ui/prolusion/${id}`),
    create: (data: { title: string; goal: string; created_by?: string; ssot_refs?: string[] }) =>
      post<{ id: string; title: string; status: string; current_stage: number }>('/api/ui/prolusion', data),
    update: (id: string, data: Partial<{
      title: string; goal: string;
      demand_analysis: ProlusionDemandAnalysis;
      code_mapping: ProlusionCodeMapping;
      tech_overview: ProlusionTechOverview;
      task_allocation: ProlusionTaskItem[];
      ssot_refs: string[];
    }>) => patch<{ ok: boolean }>(`/api/ui/prolusion/${id}`, data),
    advance: (id: string) =>
      post<{ current_stage: number; status: string }>(`/api/ui/prolusion/${id}/advance`),
    complete: (id: string) =>
      post<{ ok: boolean }>(`/api/ui/prolusion/${id}/complete`),
    dispatch: (id: string) =>
      post<{ ok: boolean; task_ids: string[] }>(`/api/ui/prolusion/${id}/dispatch`),
    generatePrompts: (id: string) =>
      post<{ ok: boolean; prompts: Array<{ task_index: number; task_title: string; agent_type: string; prompt: string }>; model?: string }>(`/api/ui/prolusion/${id}/generate-prompts`),
    aiPlan: (id: string, mode?: string) =>
      post<{ ok: boolean; model?: string; code_mapping?: unknown; tech_overview?: unknown; task_allocation?: unknown }>(`/api/ui/prolusion/${id}/ai-plan`, { mode }),
    remove: (id: string) =>
      del<{ ok: boolean }>(`/api/ui/prolusion/${id}`),
  },

  polarclaw: {
    models: () => get<{ models: string[]; intent_models: Record<string, string> }>('/api/ui/polarclaw/models'),
    start: (model?: string) =>
      post<{ session_id: string; prompt_id: string; model: string }>('/api/ui/polarclaw/start', { model }),
    forward: (promptId: string) =>
      post<{ prompt_id: string; content: string; model: string }>(`/api/ui/polarclaw/forward/${promptId}`),
    endSession: (sessionId: string) =>
      del<{ ok: boolean }>(`/api/ui/polarclaw/session/${sessionId}`),
  },
  pilotStatus: {
    summary: () => get<PilotStatusSummary>('/api/ui/pilot-status'),
    project: (id: string) => get<LobsterStatus & { events: LobsterEvent[] }>(`/api/ui/pilot-status/${id}`),
  },

  alignment: {
    list: (status?: string) => get<AlignmentDoc[]>(`/api/ui/alignment${status ? `?status=${status}` : ''}`),
    get: (id: string) => get<AlignmentDoc>(`/api/ui/alignment/${id}`),
    create: (data: Partial<AlignmentDoc>) => post<{ id: string; status: string; version: number }>('/api/ui/alignment', data),
    update: (id: string, data: Partial<AlignmentDoc> & { changed_by?: string }) =>
      patch<{ ok: boolean; version: number }>(`/api/ui/alignment/${id}`, data),
    confirmSection: (id: string, sectionName: string, confirmed: boolean, comment?: string) =>
      post<{ ok: boolean; sections: AlignmentSection[]; all_confirmed: boolean }>(
        `/api/ui/alignment/${id}/confirm-section`,
        { section_name: sectionName, confirmed, comment },
      ),
    approve: (id: string, force = false) =>
      post<{ ok: boolean; status: string }>(`/api/ui/alignment/${id}/approve`, { force }),
    complete: (id: string, summary?: string) =>
      post<{ ok: boolean; status: string; summary?: string }>(`/api/ui/alignment/${id}/complete`, { summary }),
    reject: (id: string, comment?: string) =>
      post<{ ok: boolean; status: string; comment?: string }>(`/api/ui/alignment/${id}/reject`, { comment }),
    versions: (id: string) => get<AlignmentVersion[]>(`/api/ui/alignment/${id}/versions`),
  },

  ssotAudit: {
    getAuditStatus: () => get<{ projects: AuditProjectStatus[] }>('/api/ssot/audit-status'),
    getInboxFlags: () => get<{ flags: InboxFlag[] }>('/api/ssot/inbox-flags'),
    getAuditReport: (reportId: string) => get<Record<string, unknown>>(`/api/ssot/audit-reports/${reportId}`),
  },

  uploads: {
    upload: async (
      items: { file: File; relPath: string }[],
    ): Promise<{
      ok: boolean
      dir: string
      roots: { name: string; path: string; isDir: boolean }[]
      files: { path: string; size: number }[]
    }> => {
      const form = new FormData()
      const paths: string[] = []
      // Stream the raw File objects (memory-safe for large folders — the browser
      // streams them from disk during the request). Browsers strip the directory
      // from multipart filenames, so each file's relative path travels in `paths`,
      // letting the server rebuild a dragged folder's structure.
      for (const { file, relPath } of items) {
        form.append('files', file, relPath.split('/').pop() || file.name)
        paths.push(relPath)
      }
      form.append('paths', JSON.stringify(paths))
      let res: Response
      try {
        res = await fetch(`${BASE}/api/ui/uploads`, { method: 'POST', body: form })
      } catch (e) {
        console.error('uploads.upload fetch failed:', e)
        throw new Error(
          '上传请求被浏览器拦截（net::ERR_ACCESS_DENIED / Failed to fetch）。'
          + '请点 📎 用系统选择器选文件，或到「系统设置 → 隐私与安全性 → 文件与文件夹」给 Chrome 重新授权后重启浏览器（也可改用 Safari/Edge）。',
        )
      }
      if (!res.ok) {
        let detail = ''
        try {
          const j = await res.json() as { detail?: string }
          if (j?.detail) detail = `：${j.detail}`
        } catch { /* non-JSON body */ }
        throw new Error(`上传失败（HTTP ${res.status}）${detail}`)
      }
      return res.json()
    },
  },
}

export interface AuditProjectStatus {
  name: string;
  lastAuditAt: string | null;
  severity: 'clean' | 'minor' | 'major' | 'critical' | 'unknown';
  issueCount: number;
  latestReportId: string | null;
}

export interface InboxFlag {
  id: string;
  severity: string;
  project: string;
  findings: any[];
  timestamp: string;
  read: boolean;
}
