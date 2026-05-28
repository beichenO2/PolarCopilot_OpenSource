export interface Agent {
  agent_id: string
  label: string | null
  display_name: string | null
  agent_type: string
  parent_agent_id: string | null
  role: string
  role_status: string
  last_ping: string | null
  alive?: boolean
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
