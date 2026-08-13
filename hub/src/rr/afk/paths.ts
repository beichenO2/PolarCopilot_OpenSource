import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RrAfkTaskIndex } from './types.js';

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidTaskId(taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error('invalid_task_id');
  return taskId;
}

export function afkRoot(): string {
  const override = process.env.RR_AFK_ROOT;
  if (override) return override;
  return join(homedir(), '.rr-cursor', 'afk');
}

export function legacyAfkRoot(): string {
  const override = process.env.RR_AFK_LEGACY_ROOT;
  if (override) return override;
  return join(homedir(), '.cursor', 'afk');
}

export function tasksRoot(): string {
  return join(afkRoot(), 'tasks');
}

export function indexPath(): string {
  return join(tasksRoot(), 'index.json');
}

export function taskDir(taskId: string): string {
  return join(tasksRoot(), assertValidTaskId(taskId));
}

export function statePath(taskId: string): string {
  return join(taskDir(taskId), 'state.json');
}

export function summaryPath(taskId: string): string {
  return join(taskDir(taskId), 'summary.json');
}

export function eventsPath(taskId: string): string {
  return join(taskDir(taskId), 'events.jsonl');
}

export function lockPath(taskId: string): string {
  return join(taskDir(taskId), 'lock');
}

function readIndexSafe(): RrAfkTaskIndex | null {
  const path = indexPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RrAfkTaskIndex;
  } catch {
    return null;
  }
}

export function resolveActiveTasks(): string[] {
  const index = readIndexSafe();
  if (!index || !Array.isArray(index.active_tasks)) return [];
  return [...new Set(index.active_tasks.filter((taskId) => typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId)))];
}
