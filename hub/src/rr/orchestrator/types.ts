import type { RrAfkSummary } from '../afk/index.js';
import type { RrMessage, RrSession, RrSubagentView } from '../types.js';

export interface OrchestratorConfig {
  hubUrl: string;
  projectRoot: string;
  masterSessionId: string | null;
  masterSessionName: string | null;
  afkRoot: string;
  pollIntervalMs: number;
  idleInjectDelayMs: number;
  offlineWakeDelayMs: number;
  maxInjectionsPerHour: number;
  maxLoops: number;
  autoDispatchSubagents: boolean;
  loopBridge: boolean;
  loopSentinelPrefix: string;
  todoPaths: string[];
  criteriaPaths: string[];
  verifyCommands: string[];
  injectPrefix: string;
  statePath: string;
  logPath: string;
  maintainSubagentPool?: boolean;
  allowNewSubagents?: boolean;
  desiredSubagents?: number;
  managedSubagentIds?: string[];
  subagentRecoveryCooldownMs?: number;
  subagentPruneAfterMs?: number;
  subagentHeadless?: boolean;
  /** When false, skip PolarBudget pause/resume shedder on each tick. Default true. */
  budgetShedder?: boolean;
  /** Optional allowlist of PolarProcess service ids that may be paused under critical pressure. */
  budgetPausableServiceIds?: string[];
  budgetMaxPausePerTick?: number;
  budgetMaxResumePerTick?: number;
}

/** Per-AFK-task inject/cooldown state — keyed by taskId in OrchestratorState.tasks */
export interface TaskOrchestratorState {
  loopCount: number;
  lastInjectedAt: number | null;
  lastInjectedHash: string | null;
  lastSessionId: string | null;
  lastAction: string | null;
  injectionCount: number;
  injectionWindowStart: number;
  paused: boolean;
}

export interface OrchestratorState {
  startedAt: number;
  lastTickAt: number;
  injectionCount: number;
  injectionWindowStart: number;
  loopCount: number;
  lastInjectedAt: number | null;
  lastInjectedHash: string | null;
  lastSessionId: string | null;
  lastAction: string | null;
  paused: boolean;
  /** Per-task orchestrator slice — enables unlimited parallel AFK tasks */
  tasks?: Record<string, TaskOrchestratorState>;
  managedSubagentIds: string[];
  lastPoolRecoveryAt: Record<string, number>;
  lastPoolAction: string | null;
  pool: {
    desired: number;
    managed: number;
    online: number;
    waiting: number;
    offline: number;
  };
}

export interface AfkSnapshot {
  active: boolean;
  paused: boolean;
  done: boolean;
  taskDir: string | null;
  criteriaText: string | null;
  todoText: string | null;
  maxLoops: number;
  /** RR AFK summaries when ~/.rr-cursor/afk has task data */
  summaries?: RrAfkSummary[];
  /** Primary active or most-recent task summary */
  primarySummary?: RrAfkSummary | null;
  taskId?: string | null;
  source?: 'rr-afk' | 'legacy';
}

export interface PlannerInput {
  config: OrchestratorConfig;
  state: OrchestratorState;
  afk: AfkSnapshot;
  session: RrSession;
  history: RrMessage[];
  subagents: RrSubagentView[];
}

export type PlannerAction =
  | { kind: 'noop'; reason: string }
  | { kind: 'pause'; reason: string }
  | { kind: 'done'; reason: string }
  | { kind: 'inject'; content: string; reason: string }
  | { kind: 'dispatch'; targetSessionId: string; content: string; reason: string }
  | { kind: 'wake'; content: string; reason: string };

export interface OrchestratorTick {
  at: number;
  sessionId: string;
  taskId?: string | null;
  action: PlannerAction;
}

export interface HubClientOptions {
  hubUrl: string;
}
