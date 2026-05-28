import type { Logger } from 'pino';

/** Server context shared across MCP sessions (process-wide). */
export type HubContext = {
  logger: Logger;
  hubStartedAt: Date;
};

export type MessageRow = {
  id: string;
  agentId: string;
  payload: unknown;
  createdAt: Date;
  consumedAt: Date | null;
};

/** Durable fan-out event for hub broadcast + poll fallback (Phase 2). */
export type BroadcastEvent = {
  id: string;
  agent_id: string;
  topic: string;
  payload: unknown;
  timestamp: Date;
};

/** Subscription filter for an agent's event stream (Phase 2). */
export type EventSubscription = {
  agent_id: string;
  /** Topic names; empty array means all topics (hub may still apply server defaults). */
  topics: string[];
};

/** Versioned document under `.planning/` — authoritative project state (Phase 2). */
export type PlanningDocument = {
  path: string;
  content: string;
  version: number;
  updated_by: string;
  updated_at: Date;
};

/** Server-side idempotency ledger entry (Phase 2). */
export type IdempotencyRecord = {
  key: string;
  result: unknown;
  created_at: Date;
  expires_at: Date;
};

/** Result of an atomic state write with optimistic concurrency (Phase 2). */
export type AtomicWriteResult =
  | { status: 'success'; version: number }
  | { status: 'conflict'; version: number };

export type TaskStatus = 'open' | 'claimed' | 'done' | 'blocked' | 'cancelled';

export type WorkflowStage = 'discuss' | 'research' | 'compile' | 'plan' | 'execute' | 'verify';

/** First-class schedulable unit with lease and workflow tagging (Phase 3). */
export type Task = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  owner_agent_id: string | null;
  parent_task_id: string | null;
  depends_on: string[];
  workflow_stage: WorkflowStage;
  priority: number;
  module: string | null;
  created_at: Date;
  updated_at: Date;
  lease_expires_at: Date | null;
};

/** Parameters for claiming a task with a time-bounded lease (Phase 3). */
export type TaskClaim = {
  task_id: string;
  agent_id: string;
  lease_duration_ms: number;
  heartbeat_interval_ms: number;
};

/** Directed dependency edge between tasks (Phase 3). */
export type TaskDependency = {
  task_id: string;
  depends_on_task_id: string;
};

/** Exclusive edit right for a repo-relative path (Phase 4). */
export type PathLease = {
  path: string;
  agent_id: string;
  lease_id: string;
  expires_at: Date;
  created_at: Date;
};

export type InterventionBehavior = 'auto' | 'notify' | 'block';

/** Per–workflow-stage human intervention mode (Phase 4). */
export type InterventionMatrix = Record<WorkflowStage, InterventionBehavior>;

export type AutomationPreset = 'full_auto' | 'semi_auto' | 'interactive';

/** Persisted `config.json` validated at hub boundary (Phase 4). */
export type HubConfig = {
  /** Monotonic config revision for optimistic updates (hub may mirror from file mtime). */
  version: number;
  automation_preset: AutomationPreset;
  intervention_matrix: InterventionMatrix;
  workspace_root?: string;
  default_lease_ttl_ms?: number;
  default_task_lease_ms?: number;
};

/** Persisted loop progress for resume / handoff (Phase 5). */
export type AgentCheckpoint = {
  agent_id: string;
  task_id: string;
  progress_summary: string;
  context_snapshot: unknown;
  timestamp: Date;
};

/** Registered agent roles and tool/skill hints for routing (Phase 5). */
export type AgentCapability = {
  agent_id: string;
  roles: string[];
  skills: string[];
};

/**
 * Module-ownership affinity record.
 * Tracks which modules an agent "owns" — either explicitly declared
 * or implicitly earned by completing tasks in that module.
 */
export type ModuleAffinity = {
  agent_id: string;
  module: string;
  /** Explicit ownership declared on register, vs implicit from task history. */
  source: 'declared' | 'earned';
  /** Number of tasks completed in this module (earned affinity strength). */
  completed_count: number;
};

export type AgentLoopStatus = 'working' | 'waiting' | 'error';

/** Inner autonomy loop bookkeeping (Phase 5). */
export type AgentLoopState = {
  iteration: number;
  phase: WorkflowStage;
  status: AgentLoopStatus;
};

/** Serializable package for cross-session continuation (Phase 5). */
export type HandoffPackage = {
  task_id: string;
  checkpoint: AgentCheckpoint;
  remaining_steps: string[];
  artifacts: string[];
};

/** Enforced per-loop resource caps (Phase 6). */
export type SafetyLimits = {
  max_tool_calls: number;
  max_tokens: number;
  max_wall_time_ms: number;
};

/** Append-only audit trail row (Phase 6). */
export type AuditEntry = {
  id: string;
  agent_id: string;
  task_id: string | null;
  action: string;
  details: unknown;
  timestamp: Date;
  correlation_id: string | null;
};

/** Operator-facing liveness and backlog signals (Phase 6). */
export type HealthStatus = {
  stale_agents: string[];
  queue_depth: number;
  active_tasks: number;
  anomalies: string[];
};

/** Rolled-up completion metrics for a workflow stage (Phase 6). */
export type ProgressAggregate = {
  phase: WorkflowStage;
  completed: number;
  total: number;
  active_agents: number;
};

/** A file touched by an Agent diff (Phase 21 — SoTADiff). */
export type SoTADiffFile = {
  path: string;
  op: 'create' | 'modify' | 'delete';
  lines_changed: number;
};

/** Recorded Agent change entry for conflict detection (Phase 21 — SoTADiff). */
export type SoTADiffEntry = {
  id: string;
  agent_id: string;
  git_commit: string | null;
  intent: string;
  files: SoTADiffFile[];
  summary: string;
  created_at: Date;
};

/** Conflict detected when two agents modify the same file (Phase 21). */
export type SoTADiffConflict = {
  file_path: string;
  prior_entry_id: string;
  prior_agent_id: string;
  prior_summary: string;
  prior_created_at: Date;
};
