export type RrSessionStatus = 'online' | 'waiting' | 'working' | 'offline';

export interface RrXjCompatibility {
  source: 'xj';
  sourceHash: string;
  raw: Record<string, unknown>;
}

export interface RrTaskProgress {
  text: string;
  percent?: number;
  updatedAt: number;
}

export interface RrActiveTask {
  taskId: string;
  masterSessionId: string;
  targetSessionId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  progress?: RrTaskProgress;
}

export interface RrSession {
  sessionId: string;
  name: string;
  role?: string;
  launchId?: string;
  title: string;
  /** 用户在面板重命名后锁定，禁止 Agent/Hub 自动改写 title（及 register 回写 name） */
  titleLocked?: boolean;
  createdAt: number;
  lastActiveAt: number;
  agentStatus: string;
  waiting: boolean;
  pendingMessages: number;
  online: boolean;
  isSubagent: boolean;
  uiLocale: string;
  lastMessageTs: number;
  status: RrSessionStatus;
  /** Hub-spawned cursor-agent CLI pid; cleared when process exits or session removed */
  cursorAgentPid?: number;
  /** PolarProcess service id for this session's cursor-agent (rr-cursor-{sessionId}) */
  polarProcessServiceId?: string;
  activeTask?: RrActiveTask;
  compat?: RrXjCompatibility;
}

export interface RrMessage {
  msgId: string;
  sessionId: string;
  from: string;
  to: string;
  role: 'user' | 'assistant' | 'system' | 'progress';
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
  compat?: RrXjCompatibility;
}

export interface RrSubagentView {
  sessionId: string;
  name: string;
  availability: 'idle' | 'busy' | 'offline';
  agentStatus: string;
  lastActiveAt: number;
  activeTask?: RrActiveTask;
}

export interface RrResumeContext {
  session: RrSession;
  sourceSession: Record<string, unknown>;
  sourceLastActiveAt: number;
  history: RrMessage[];
  tasks: Array<Record<string, unknown>>;
  workspace?: Record<string, unknown>;
  topology: Record<string, unknown>;
}
