export const RR_AFK_STATUSES = [
  'PLANNING',
  'READY',
  'RUNNING',
  'UNIT_DONE',
  'READY_TO_MERGE',
  'DONE',
  'PAUSED',
  'NEEDS_HUMAN',
  'BLOCKED',
] as const;

export type RrAfkStatus = (typeof RR_AFK_STATUSES)[number];

/** AFK execution mode: start (collaborative) | solo (never-ask) | go (single-master infinite MCP). */
export type RrAfkMode = 'start' | 'solo' | 'go';

export interface RrAfkPermissionRequest {
  kind: 'temporary_write_paths' | string;
  unit: string;
  plan_revision: number;
  paths: string[];
}

export interface RrAfkHeartbeat {
  automation_id: string | null;
}

export interface RrAfkState {
  task_id: string;
  status: RrAfkStatus;
  master_session_id: string | null;
  project_root: string;
  current_unit: string | null;
  plan_revision: number;
  loop: number;
  max_loops: number;
  allowlist: string[];
  permission_request: RrAfkPermissionRequest | null;
  last_command: string | null;
  last_verification: unknown;
  human_action_hint: string | null;
  updated_at: string;
  heartbeat?: RrAfkHeartbeat;
  mode?: RrAfkMode;
  /** Task-scoped Subagent create/dispatch policy. go forces false; omit → follow global panel. */
  allow_new_subagents?: boolean;
}

export interface RrAfkSummary {
  task_id: string;
  status: RrAfkStatus;
  master_session_id: string | null;
  current_unit: string | null;
  plan_revision: number;
  loop: number;
  allowlist: string[];
  permission_request: RrAfkPermissionRequest | null;
  last_command: string | null;
  last_verification: unknown;
  human_action_hint: string | null;
  updated_at: string;
  heartbeat?: RrAfkHeartbeat;
  project_root?: string;
  mode?: RrAfkMode;
  /** Task-scoped Subagent policy (see state.allow_new_subagents). */
  allow_new_subagents?: boolean;
}

export interface RrAfkTaskIndex {
  active_tasks: string[];
  updated_at: string;
}

export interface RrAfkEvent {
  at: string;
  kind: string;
  detail?: unknown;
}

export interface InitTaskArtifactsInput {
  taskId: string;
  projectRoot: string;
  masterSessionId: string | null;
  plan?: string;
  criteria?: string;
  tasks?: string;
  maxLoops?: number;
  activate?: boolean;
  mode?: RrAfkMode;
}
