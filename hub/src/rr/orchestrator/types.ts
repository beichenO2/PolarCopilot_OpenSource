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
}

export interface AfkSnapshot {
  active: boolean;
  paused: boolean;
  done: boolean;
  taskDir: string | null;
  criteriaText: string | null;
  todoText: string | null;
  maxLoops: number;
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
  action: PlannerAction;
}

export interface HubClientOptions {
  hubUrl: string;
}
