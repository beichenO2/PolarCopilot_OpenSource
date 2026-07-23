export type XjSessionStatus =
  | 'connecting'
  | 'online'
  | 'pending'
  | 'waiting'
  | 'working'
  | 'paused'
  | 'completed'
  | 'offline';

export type XjMessageRole = 'user' | 'assistant' | 'system' | 'progress';
export type XjAgentSlot = 'main' | 'subagent-1' | 'subagent-2';

export interface XjSession {
  id: string;
  clientKey: string;
  launchId?: string;
  name?: string;
  role?: string;
  agentStatus?: string;
  parentSessionId?: string;
  agentSlot?: XjAgentSlot;
  title: string;
  status: XjSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  reconnectUntil: string;
  pendingCount: number;
  modes: string[];
}

export interface XjMessage {
  id: string;
  sessionId: string;
  role: XjMessageRole;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface XjProgress {
  percent: number;
  summary: string;
  todo: string[];
  evidence: string[];
  updatedAt: string;
}

export type XjAutomationState = 'idle' | 'running' | 'paused' | 'done';

export interface XjAutomation {
  enabled: boolean;
  state: XjAutomationState;
  loop: number;
  loopLimit: number;
  acceptanceCriteria: string[];
  completedCriteria: string[];
  todo: string[];
  negativeKnowledge: string[];
  pauseReason?: string;
  lastReflection?: string;
  updatedAt: string;
}

export interface XjSkillMatch {
  name: string;
  description: string;
  path: string;
  bundle: string;
  reasons: string[];
}
