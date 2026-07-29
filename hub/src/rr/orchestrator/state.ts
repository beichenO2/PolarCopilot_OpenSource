import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrchestratorState, OrchestratorTick } from './types.js';

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
