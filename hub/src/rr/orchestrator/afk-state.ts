import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listTaskSummaries,
  readState,
  readSummary,
  resolveActiveTasks,
  taskDir as rrTaskDir,
} from '../afk/index.js';
import type { RrAfkSummary } from '../afk/index.js';
import type { AfkSnapshot, OrchestratorConfig } from './types.js';

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function detectLegacyTaskDir(afkRoot: string): string | null {
  if (!existsSync(afkRoot)) return null;
  const entries = readdirSync(afkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(afkRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'CRITERIA.md')) || existsSync(join(dir, 'TODO.md')));
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b.localeCompare(a))[0] ?? null;
}

function pickPrimarySummary(
  summaries: RrAfkSummary[],
  activeTaskIds: string[],
): RrAfkSummary | null {
  if (summaries.length === 0) return null;
  for (const taskId of activeTaskIds) {
    const match = summaries.find((summary) => summary.task_id === taskId);
    if (match) return match;
  }
  return summaries[0] ?? null;
}

/** Build an AfkSnapshot for one taskId (authoritative per-task view for orchestrator ticks). */
export function readTaskAfkSnapshot(config: OrchestratorConfig, taskId: string): AfkSnapshot | null {
  const summary = readSummary(taskId);
  if (!summary) return null;

  const activeTaskIds = resolveActiveTasks();
  const dir = rrTaskDir(taskId);
  const state = readState(taskId);
  const status = summary.status;

  const active = activeTaskIds.includes(taskId) && status !== 'DONE' && status !== 'PAUSED';
  const paused = status === 'PAUSED';
  const done = status === 'DONE';

  const criteriaPath = existsSync(join(dir, 'CRITERIA.md'))
    ? join(dir, 'CRITERIA.md')
    : firstExisting(summary.project_root ?? config.projectRoot, config.criteriaPaths);
  const todoPath = existsSync(join(dir, 'TODO.md'))
    ? join(dir, 'TODO.md')
    : firstExisting(summary.project_root ?? config.projectRoot, config.todoPaths);

  return {
    active,
    paused,
    done,
    taskDir: dir,
    criteriaText: criteriaPath ? readText(criteriaPath) : null,
    todoText: todoPath ? readText(todoPath) : null,
    maxLoops: state?.max_loops ?? config.maxLoops,
    summaries: listTaskSummaries(),
    primarySummary: summary,
    taskId,
    source: 'rr-afk',
  };
}

/** All eligible active AFK tasks — one snapshot per taskId for parallel orchestrator ticks. */
export function readActiveTaskSnapshots(config: OrchestratorConfig): AfkSnapshot[] {
  const activeTaskIds = resolveActiveTasks();
  if (activeTaskIds.length > 0) {
    return activeTaskIds
      .map((taskId) => readTaskAfkSnapshot(config, taskId))
      .filter((snapshot): snapshot is AfkSnapshot => Boolean(snapshot?.active));
  }

  const legacy = readLegacyAfkSnapshot(config);
  if (legacy.active && !legacy.paused && !legacy.done) {
    return [legacy];
  }
  return [];
}

function readRrAfkSnapshot(config: OrchestratorConfig): AfkSnapshot | null {
  const summaries = listTaskSummaries();
  if (summaries.length === 0) return null;

  const activeTaskIds = resolveActiveTasks();
  const primarySummary = pickPrimarySummary(summaries, activeTaskIds);
  if (!primarySummary) return null;

  const taskId = primarySummary.task_id;
  const dir = rrTaskDir(taskId);
  const state = readState(taskId);
  const status = primarySummary.status;

  const active = activeTaskIds.includes(taskId) && status !== 'DONE' && status !== 'PAUSED';
  const paused = status === 'PAUSED';
  const done = status === 'DONE';

  const criteriaPath = existsSync(join(dir, 'CRITERIA.md'))
    ? join(dir, 'CRITERIA.md')
    : firstExisting(config.projectRoot, config.criteriaPaths);
  const todoPath = existsSync(join(dir, 'TODO.md'))
    ? join(dir, 'TODO.md')
    : firstExisting(config.projectRoot, config.todoPaths);

  return {
    active,
    paused,
    done,
    taskDir: dir,
    criteriaText: criteriaPath ? readText(criteriaPath) : null,
    todoText: todoPath ? readText(todoPath) : null,
    maxLoops: state?.max_loops ?? config.maxLoops,
    summaries,
    primarySummary: readSummary(taskId) ?? primarySummary,
    taskId,
    source: 'rr-afk',
  };
}

function readLegacyAfkSnapshot(config: OrchestratorConfig): AfkSnapshot {
  const active = existsSync(join(config.afkRoot, 'ACTIVE'));
  const paused = existsSync(join(config.afkRoot, 'PAUSE'));
  const done = existsSync(join(config.afkRoot, 'DONE'));
  const taskDir = detectLegacyTaskDir(config.afkRoot);
  const maxLoopsRaw = readText(join(config.afkRoot, 'MAX_LOOPS'));
  const maxLoops = maxLoopsRaw ? Number(maxLoopsRaw.trim()) || config.maxLoops : config.maxLoops;

  const criteriaPath = taskDir
    ? join(taskDir, 'CRITERIA.md')
    : firstExisting(config.projectRoot, config.criteriaPaths);
  const todoPath = taskDir
    ? join(taskDir, 'TODO.md')
    : firstExisting(config.projectRoot, config.todoPaths);

  return {
    active,
    paused,
    done,
    taskDir,
    criteriaText: criteriaPath ? readText(criteriaPath) : null,
    todoText: todoPath ? readText(todoPath) : null,
    maxLoops,
    source: 'legacy',
  };
}

export function readAfkSnapshot(config: OrchestratorConfig): AfkSnapshot {
  const rrSnapshot = readRrAfkSnapshot(config);
  if (rrSnapshot) return rrSnapshot;
  return readLegacyAfkSnapshot(config);
}

export function parseTodoItems(todoText: string | null): string[] {
  if (!todoText) return [];
  return todoText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[ \]/.test(line))
    .map((line) => line.replace(/^[-*]\s+\[ \]\s*/, '').trim())
    .filter(Boolean);
}

export function parseCriteriaSummary(criteriaText: string | null): string[] {
  if (!criteriaText) return [];
  return criteriaText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\./.test(line))
    .slice(0, 12);
}
