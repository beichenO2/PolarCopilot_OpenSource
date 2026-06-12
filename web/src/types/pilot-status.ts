export type LobsterState = 'dormant' | 'active' | 'failed' | 'offline'

export interface LobsterStatus {
  project_id: string
  project_name: string
  state: LobsterState
  last_active_at: string | null
  current_node: string | null
  active_targets: number
  uptime_ms: number | null
  error?: string
}

export interface LobsterEvent {
  id: string
  timestamp: string
  type: string
  source_project: string
  target_project?: string
  severity: 'info' | 'warn' | 'error'
  description: string
  dedup_key?: string
}

export interface PilotStatusSummary {
  projects: LobsterStatus[]
  recent_events: LobsterEvent[]
  polarclaw_reachable: boolean
  last_refresh: string
}
