import type { Agent, Prompt, AgentsSummary } from '../types/hub'

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
    try {
      const j = await res.json() as { error?: string; message?: string }
      detail = j.error || j.message || ''
    } catch { /* no body */ }
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

  health: {
    check: () => get<{ status: string; service: string; uptime: number }>('/api/ui/health'),
  },

  alignment: {
    list: (status?: string) =>
      get<AlignmentDoc[]>(status ? `/api/ui/alignment?status=${encodeURIComponent(status)}` : '/api/ui/alignment'),
    get: (id: string) => get<AlignmentDoc>(`/api/ui/alignment/${id}`),
    create: (data: {
      agent_id?: string
      goal?: string
      work_logic?: string
      workflows?: AlignmentWorkflow[]
      plan_markdown?: string
      sections?: AlignmentSection[]
      status?: string
    }) => post<{ id: string; status: string; version: number; coverage?: unknown }>('/api/ui/alignment', data),
    update: (id: string, data: Partial<AlignmentDoc> & { changed_by?: string }) =>
      patch<{ ok: boolean; version: number }>(`/api/ui/alignment/${id}`, data),
    coverage: (id: string) => get<{ id: string; status: string; coverage: unknown }>(`/api/ui/alignment/${id}/coverage`),
    confirmSection: (id: string, section_name: string, confirmed: boolean, comment?: string) =>
      post<{ ok: boolean; sections: AlignmentSection[]; all_confirmed: boolean }>(
        `/api/ui/alignment/${id}/confirm-section`,
        { section_name, confirmed, comment },
      ),
    approve: (id: string, force?: boolean) =>
      post<{ ok: boolean; status: string }>(`/api/ui/alignment/${id}/approve`, { force }),
    reject: (id: string, comment?: string) =>
      post<{ ok: boolean; status: string }>(`/api/ui/alignment/${id}/reject`, { comment }),
    complete: (id: string, summary?: string) =>
      post<{ ok: boolean; status: string }>(`/api/ui/alignment/${id}/complete`, { summary }),
    versions: (id: string) => get<AlignmentVersion[]>(`/api/ui/alignment/${id}/versions`),
  },
}
