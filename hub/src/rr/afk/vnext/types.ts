/** AFK vNext control-plane types — runtime SSoT is SQLite, not file flags. */

export const AFK_TASK_STATUSES = [
  'DRAFT',
  'PLANNING',
  'QUEUED',
  'RUNNING',
  'VERIFYING',
  'READY_TO_DELIVER',
  'DONE',
  'PAUSED',
  'BLOCKED',
  'NEEDS_HUMAN',
  'CANCELLED',
  'FAILED_RECOVERABLE',
] as const;

export type AfkTaskStatus = (typeof AFK_TASK_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<AfkTaskStatus> = new Set([
  'DONE',
  'CANCELLED',
]);

/** Statuses that may appear in runnable/active queries. DONE is never among them. */
export const ACTIVE_QUERY_STATUSES: ReadonlySet<AfkTaskStatus> = new Set([
  'DRAFT',
  'PLANNING',
  'QUEUED',
  'RUNNING',
  'VERIFYING',
  'READY_TO_DELIVER',
  'PAUSED',
  'BLOCKED',
  'NEEDS_HUMAN',
  'FAILED_RECOVERABLE',
]);

export type AfkSurface = 'ide' | 'web';
export type AfkExecutorKind = 'cursor-native' | 'cursor-cli';

export type AfkUnitState =
  | 'pending'
  | 'leased'
  | 'in_progress'
  | 'verifying'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type AfkCriterionStatus = 'pending' | 'pass' | 'fail' | 'skipped';

export interface AfkTaskRow {
  task_id: string;
  goal: string;
  project_root: string;
  surface: AfkSurface;
  status: AfkTaskStatus;
  mode: 'start' | 'solo';
  priority: number;
  last_scheduled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AfkRunRow {
  run_id: string;
  task_id: string;
  executor_kind: AfkExecutorKind;
  native_handle: string | null;
  conversation_id: string | null;
  pid: number | null;
  service_id: string | null;
  heartbeat_at: string | null;
  attempt: number;
  status: 'owner' | 'superseded' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface AfkWorkUnitRow {
  unit_id: string;
  task_id: string;
  parent_id: string | null;
  state: AfkUnitState;
  role: string;
  lane_key: string;
  allowed_writes: string; // JSON array
  verify_cmd: string | null;
  attempt: number;
  lease_owner: string | null;
  lease_expiry: string | null;
  created_at: string;
  updated_at: string;
}

export interface AfkCriterionRow {
  criterion_id: string;
  task_id: string;
  text: string;
  required: number; // 0|1
  status: AfkCriterionStatus;
  evidence_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AfkEvidenceRow {
  evidence_id: string;
  task_id: string;
  command: string;
  exit_code: number;
  salient: string;
  timestamp: string;
  artifact_digest: string | null;
  producer_role: string;
}

export interface TransitionError {
  code: 'illegal_transition' | 'invariant' | 'not_found' | 'gate_failed' | 'lease_conflict';
  message: string;
  detail?: unknown;
}

/** Legal main-path + side-path transitions (from → to[]). */
export const LEGAL_TRANSITIONS: Record<AfkTaskStatus, readonly AfkTaskStatus[]> = {
  DRAFT: ['PLANNING', 'CANCELLED'],
  PLANNING: ['QUEUED', 'RUNNING', 'PAUSED', 'CANCELLED', 'NEEDS_HUMAN'],
  QUEUED: ['RUNNING', 'PAUSED', 'CANCELLED'],
  RUNNING: ['VERIFYING', 'PAUSED', 'BLOCKED', 'NEEDS_HUMAN', 'FAILED_RECOVERABLE', 'CANCELLED'],
  VERIFYING: ['RUNNING', 'READY_TO_DELIVER', 'FAILED_RECOVERABLE', 'PAUSED', 'BLOCKED', 'NEEDS_HUMAN'],
  READY_TO_DELIVER: ['DONE', 'VERIFYING', 'RUNNING', 'PAUSED', 'CANCELLED'],
  DONE: [], // terminal — only completion gate may write DONE via forceDoneWithGate
  PAUSED: ['QUEUED', 'RUNNING', 'PLANNING', 'CANCELLED'],
  BLOCKED: ['RUNNING', 'PAUSED', 'NEEDS_HUMAN', 'CANCELLED', 'FAILED_RECOVERABLE'],
  NEEDS_HUMAN: ['RUNNING', 'PAUSED', 'CANCELLED'],
  CANCELLED: [],
  FAILED_RECOVERABLE: ['RUNNING', 'PLANNING', 'PAUSED', 'CANCELLED'],
};
