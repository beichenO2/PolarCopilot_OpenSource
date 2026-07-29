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
  /** 用户重命名后锁定，禁止 Agent/Hub 自动改写 */
  titleLocked?: boolean
  createdAt: number
  lastActiveAt: number
  lastMessageTs?: number
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

export type RrSpawnQueueJobStatus = 'pending' | 'spawning' | 'waiting_online' | 'done' | 'failed'

export interface RrSpawnQueueJob {
  jobId: string
  sessionId: string
  label: string
  status: RrSpawnQueueJobStatus
  waitUntilOnline: boolean
  pid?: number
  workspace?: string
  online?: boolean
  error?: string
}

export type RrSpawnQueueBatchStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface RrSpawnQueueBatch {
  batchId: string
  status: RrSpawnQueueBatchStatus
  jobs: RrSpawnQueueJob[]
  createdAt: number
  updatedAt: number
}

export interface RrSpawnQueueStatus {
  running: boolean
  pendingCount: number
  activeJob: RrSpawnQueueJob | null
  activeBatchId: string | null
  gapMs: number
  waitOnlineTimeoutMs: number
}

export interface RrAfkTodoProgress {
  total: number
  pending: number
  done: number
  pendingItems: string[]
}

export interface RrAfkStatus {
  ok: boolean
  active: boolean
  paused: boolean
  done: boolean
  maxLoops: number
  loopCount: number
  taskDir: string | null
  todo: RrAfkTodoProgress
  criteria: { count: number; summary: string[] }
  orchestrator: {
    enabled: boolean
    running: boolean
    serviceStatus: string | null
    masterSessionId: string | null
    lastAction: string | null
    lastInjectAt: number | null
    lastSessionId: string | null
  }
  projectRoot: string
  health: {
    ok: boolean
    enabled: boolean
    afkActive: boolean
    loopCount: number
    lastAction: string | null
  }
}

export interface RrAfkOneClickResult {
  ok: true
  sessionId: string
  armed: {
    armed: true
    afkRoot: string
    taskDir: string | null
    maxLoops: number
    masterSessionId: string | null
  }
  orchestrator: {
    enabled: boolean
    running: boolean
    polarprocess: unknown
  }
  status: RrAfkStatus
}

