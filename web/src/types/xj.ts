export type XjSessionStatus = 'connecting' | 'online' | 'pending' | 'waiting' | 'working' | 'paused' | 'completed' | 'offline'
export type XjAgentSlot = 'main' | 'subagent-1' | 'subagent-2'

export interface XjSession {
  id: string
  clientKey: string
  launchId?: string
  name?: string
  role?: string
  agentStatus?: string
  parentSessionId?: string
  agentSlot?: XjAgentSlot
  title: string
  status: XjSessionStatus
  createdAt: string
  updatedAt: string
  lastSeenAt: string
  reconnectUntil: string
  pendingCount: number
  modes: string[]
}

export interface XjMessage {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system' | 'progress'
  content: string
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface XjProgress {
  percent: number
  summary: string
  todo: string[]
  evidence: string[]
  updatedAt: string
}

export interface XjAutomation {
  enabled: boolean
  state: 'idle' | 'running' | 'paused' | 'done'
  loop: number
  loopLimit: number
  acceptanceCriteria: string[]
  completedCriteria: string[]
  todo: string[]
  negativeKnowledge: string[]
  pauseReason?: string
  lastReflection?: string
  updatedAt: string
}

export interface XjSkill {
  name: string
  description: string
  path: string
  bundle: string
  reasons?: string[]
}

export interface XjSessionDetail {
  session: XjSession
  history: XjMessage[]
  progress: XjProgress
  automation: XjAutomation
}
