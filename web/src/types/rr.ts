export type RrSessionStatus = 'online' | 'waiting' | 'working' | 'offline'

export interface RrTaskProgress {
  text: string
  percent?: number
  updatedAt: number
}

export interface RrActiveTask {
  taskId: string
  masterSessionId: string
  targetSessionId: string
  content: string
  createdAt: number
  updatedAt: number
  progress?: RrTaskProgress
}

export interface RrSession {
  sessionId: string
  name: string
  role?: string
  launchId?: string
  title: string
  createdAt: number
  lastActiveAt: number
  agentStatus: string
  waiting: boolean
  pendingMessages: number
  online: boolean
  isSubagent: boolean
  status: RrSessionStatus
  activeTask?: RrActiveTask
}

export interface RrMessage {
  msgId: string
  sessionId: string
  from: string
  to: string
  role: 'user' | 'assistant' | 'system' | 'progress'
  content: string
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface RrSessionDetail {
  session: RrSession
  history: RrMessage[]
}

export interface RrSubagent {
  sessionId: string
  name: string
  availability: 'idle' | 'busy' | 'offline'
  agentStatus: string
  lastActiveAt: number
  activeTask?: RrActiveTask
}

