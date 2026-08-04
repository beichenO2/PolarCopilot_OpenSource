import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestratorState, OrchestratorTick, TaskOrchestratorState } from './types.js';

export function defaultTaskOrchestratorState(): TaskOrchestratorState {
  const now = Date.now();
  return {
    loopCount: 0,
    lastInjectedAt: null,
    lastInjectedHash: null,
    lastSessionId: null,
    lastAction: null,
    injectionCount: 0,
    injectionWindowStart: now,
    paused: false,
  };
}

export function defaultState(): OrchestratorState {
  const now = Date.now();
  return {
    startedAt: now,
    lastTickAt: now,
    injectionCount: 0,
    injectionWindowStart: now,
    loopCount: 0,
    lastInjectedAt: null,
    lastInjectedHash: null,
    lastSessionId: null,
    lastAction: null,
    paused: false,
    tasks: {},
    managedSubagentIds: [],
    lastPoolRecoveryAt: {},
    lastPoolAction: null,
    pool: {
      desired: 0,
      managed: 0,
      online: 0,
      waiting: 0,
      offline: 0,
    },
  };
}

export function loadState(path: string): OrchestratorState {
  try {
    return { ...defaultState(), ...JSON.parse(readFileSync(path, 'utf8')) as OrchestratorState };
  } catch {
    return defaultState();
  }
}

export function saveState(path: string, state: OrchestratorState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function appendEvent(logPath: string, tick: OrchestratorTick): void {
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  appendFileSync(logPath, `${JSON.stringify({ ...tick, action: tick.action.kind, detail: tick.action })}\n`, 'utf8');
}

export function getTaskOrchestratorState(state: OrchestratorState, taskId: string): TaskOrchestratorState {
  return state.tasks?.[taskId] ?? defaultTaskOrchestratorState();
}

/** Merge per-task inject state into a planner-facing OrchestratorState view. */
export function plannerStateForTask(state: OrchestratorState, taskId: string): OrchestratorState {
  const task = getTaskOrchestratorState(state, taskId);
  return {
    ...state,
    loopCount: task.loopCount,
    lastInjectedAt: task.lastInjectedAt,
    lastInjectedHash: task.lastInjectedHash,
    lastSessionId: task.lastSessionId,
    lastAction: task.lastAction,
    injectionCount: task.injectionCount,
    injectionWindowStart: task.injectionWindowStart,
    paused: task.paused,
  };
}

function applyInjectionBump(
  task: TaskOrchestratorState,
  now: number,
  maxPerHour: number,
): TaskOrchestratorState {
  const windowMs = 60 * 60 * 1000;
  let next = { ...task };
  if (now - next.injectionWindowStart >= windowMs) {
    next.injectionWindowStart = now;
    next.injectionCount = 0;
  }
  next.injectionCount += 1;
  next.loopCount += 1;
  next.lastInjectedAt = now;
  if (next.injectionCount > maxPerHour) {
    next.paused = true;
  }
  return next;
}

export function bumpInjection(state: OrchestratorState, now: number, maxPerHour: number): OrchestratorState {
  const windowMs = 60 * 60 * 1000;
  let next = { ...state };
  if (now - next.injectionWindowStart >= windowMs) {
    next.injectionWindowStart = now;
    next.injectionCount = 0;
  }
  next.injectionCount += 1;
  next.loopCount += 1;
  next.lastInjectedAt = now;
  next.lastTickAt = now;
  if (next.injectionCount > maxPerHour) {
    next.paused = true;
  }
  return next;
}

/** Record inject/wake for one AFK task without cross-task cooldown interference. */
export function bumpTaskInjection(
  state: OrchestratorState,
  taskId: string,
  now: number,
  maxPerHour: number,
  sessionId: string,
  actionKind: string,
  contentHash?: string,
): OrchestratorState {
  const tasks = { ...(state.tasks ?? {}) };
  const bumped = applyInjectionBump(getTaskOrchestratorState(state, taskId), now, maxPerHour);
  tasks[taskId] = {
    ...bumped,
    lastSessionId: sessionId,
    lastAction: actionKind,
    ...(contentHash !== undefined ? { lastInjectedHash: contentHash } : {}),
  };
  return {
    ...state,
    tasks,
    lastTickAt: now,
    lastSessionId: sessionId,
    lastAction: `${taskId}:${actionKind}`,
  };
}
