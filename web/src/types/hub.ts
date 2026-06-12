export interface Agent {
  agent_id: string
  label: string | null
  display_name: string | null
  agent_type: string
  parent_agent_id: string | null
  role: string
  role_status: string
  last_ping: string | null
  alive: boolean
  created_at: string
}

export type PromptOption = string | { id: string; label: string }

export function optionLabel(opt: PromptOption): string {
  return typeof opt === 'string' ? opt : opt?.label ?? ''
}

export interface Prompt {
  id: string
  prompt: string
  options: PromptOption[]
  answer?: string | null
  answered?: boolean
  superseded?: boolean
  type?: string
  agent_id: string | null
  display_name: string | null
  created_at: string
  answered_at?: string | null
}

export interface HubEvent {
  id: string
  source_agent_id: string
  topic: string
  payload: unknown
  created_at: string
}

export interface Task {
  id: string
  status: string
  source?: 'hub' | 'sotagent'
  task_type?: string
  requester?: string
  owner_agent_id: string | null
  parent_task_id: string | null
  workflow_stage: string
  priority: number
  title: string
  description: string
  module: string | null
  created_at: string
  updated_at: string
  depends_on: string[]
  wave: number
  progress_percent?: number
  pid?: number | null
}

export interface ServiceHealth {
  name: string
  url: string
  consoleUrl: string
  status: 'up' | 'down' | 'unknown'
  latencyMs: number
  detail?: string
}

export interface ProjectData {
  ts: number
  polarPrivate?: {
    health?: Record<string, unknown>
    summary?: {
      identity_count?: number
      secret_count?: number
      binding_count?: number
    }
    recentProjects?: {
      items?: Array<{
        name: string
        description?: string
        created_at: string
      }>
    }
  }
  sotAgent?: Record<string, unknown>
  hub?: {
    agents: number
    agentList: Array<{ id: string; role: string; assignedAt: string }>
    tasks: {
      total: number
      open: number
      claimed: number
      done: number
      blocked: number
    }
  }
}

export interface EcoService {
  id: string
  name: string
  status: 'running' | 'stopped' | 'error'
  pid: number | null
  port: number | null
  url?: string | null
  device_id: string
  auto_start: boolean
  restart_count: number
  max_restarts: number
  started_at: string | null
  last_health_check: string | null
  is_local: boolean
  cron_schedule: string | null
  last_exit_code: number | null
  last_error: string | null
}

export interface DeviceResource {
  device: {
    id: string
    hostname: string
    platform: string
    totalMemGB: number
  }
  resource: {
    cpu_percent: number
    mem_used_mb: number
    mem_total_mb: number
    mem_percent: number
    gpu_mem_used_mb: number
    timestamp: string
  }
  tasks: {
    queued: number
    running: number
    done: number
    failed: number
  }
  projectCount: number
  assetCount: number
}

export interface PortEntry {
  port: number
  service_name: string
  project: string
  device_id: string
  allocated_at: string
  last_verified: string
  status: 'active' | 'stale' | 'released'
}

export interface AgentsSummary {
  total_alive: number
  solos: Array<{
    id: string
    name: string | null
    slaves: Array<{ id: string; name: string | null }>
  }>
  free_slaves: Array<{ id: string; name: string | null }>
  assigned_slaves: number
}
