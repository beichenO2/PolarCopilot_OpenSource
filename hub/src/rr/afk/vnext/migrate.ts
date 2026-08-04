import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AfkDb } from './db.js';
import { createTask, addWorkUnit, bindOwnerRun, transitionTask } from './store.js';
import type { AfkTaskStatus } from './types.js';

export interface MigrateReport {
  dryRun: boolean;
  sourceRoot: string;
  tasksSeen: number;
  tasksImported: number;
  skipped: string[];
  conflicts: string[];
  mapping: Array<{ legacyId: string; status: string; action: string }>;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function mapLegacyStatus(raw: string | undefined): AfkTaskStatus {
  switch (raw) {
    case 'DONE':
      return 'DONE';
    case 'PAUSED':
      return 'PAUSED';
    case 'NEEDS_HUMAN':
      return 'NEEDS_HUMAN';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'PLANNING':
      return 'PLANNING';
    case 'RUNNING':
    case 'READY':
    case 'UNIT_DONE':
    case 'READY_TO_MERGE':
      return 'RUNNING';
    default:
      return 'PLANNING';
  }
}

/**
 * Dry-run or apply migration from ~/.rr-cursor/afk file layout into vNext SQLite.
 * Does not delete legacy files. DONE tasks are imported as DONE and never listed active.
 */
export function migrateFromFileRoot(
  db: AfkDb,
  sourceRoot: string,
  opts?: { dryRun?: boolean },
): MigrateReport {
  const dryRun = opts?.dryRun !== false;
  const report: MigrateReport = {
    dryRun,
    sourceRoot,
    tasksSeen: 0,
    tasksImported: 0,
    skipped: [],
    conflicts: [],
    mapping: [],
  };

  const indexPath = join(sourceRoot, 'tasks', 'index.json');
  const index = readJson<{ active_tasks?: string[]; done_tasks?: string[] }>(indexPath);
  const tasksDir = join(sourceRoot, 'tasks');
  if (!existsSync(tasksDir)) {
    report.skipped.push('no_tasks_dir');
    return report;
  }

  const ids = new Set<string>();
  for (const id of index?.active_tasks ?? []) ids.add(id);
  for (const id of index?.done_tasks ?? []) ids.add(id);
  try {
    for (const name of readdirSync(tasksDir)) {
      if (name.startsWith('.')) continue;
      if (existsSync(join(tasksDir, name, 'state.json'))) ids.add(name);
    }
  } catch {
    /* ignore */
  }

  for (const legacyId of ids) {
    report.tasksSeen += 1;
    const state = readJson<{
      status?: string;
      project_root?: string;
      master_session_id?: string | null;
      mode?: string;
    }>(join(tasksDir, legacyId, 'state.json'));
    if (!state) {
      report.skipped.push(legacyId);
      report.mapping.push({ legacyId, status: 'missing', action: 'skip' });
      continue;
    }

    const inActive = (index?.active_tasks ?? []).includes(legacyId);
    const inDone = (index?.done_tasks ?? []).includes(legacyId) || state.status === 'DONE';
    if (inActive && inDone) {
      report.conflicts.push(`${legacyId}: active_and_done_in_index`);
    }

    // Prefer DONE if state says DONE even if still in active_tasks (repair on import)
    let status = mapLegacyStatus(state.status);
    if (state.status === 'DONE' || (inDone && !inActive)) status = 'DONE';
    if (state.status === 'DONE') status = 'DONE';

    report.mapping.push({
      legacyId,
      status,
      action: dryRun ? 'would_import' : 'import',
    });

    if (dryRun) continue;

    const existing = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(legacyId);
    if (existing) {
      report.skipped.push(`${legacyId}:already_exists`);
      continue;
    }

    createTask(db, {
      taskId: legacyId,
      goal: `migrated:${legacyId}`,
      projectRoot: state.project_root ?? '',
      surface: 'ide',
      mode: state.mode === 'start' ? 'start' : 'solo',
      status: status === 'DONE' ? 'DRAFT' : status === 'PAUSED' ? 'PAUSED' : 'PLANNING',
    });

    if (status === 'DONE') {
      // Seed a synthetic passed criterion so historical DONE stays DONE without re-gate
      // Historical imports use direct SQL to preserve DONE (gate bypass marked in events)
      const ts = new Date().toISOString();
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run('DONE', ts, legacyId);
      db.prepare(
        'INSERT INTO events(task_id, kind, detail, at) VALUES (?, ?, ?, ?)',
      ).run(legacyId, 'migrated_done', JSON.stringify({ repaired_active_conflict: inActive && inDone }), ts);
    } else if (status === 'RUNNING' || status === 'PLANNING') {
      if (status === 'RUNNING') {
        transitionTask(db, legacyId, 'RUNNING', { reason: 'migrate' });
      }
    } else if (status === 'PAUSED') {
      /* already PAUSED */
    } else if (status === 'NEEDS_HUMAN') {
      transitionTask(db, legacyId, 'NEEDS_HUMAN', { reason: 'migrate' });
    }

    if (state.master_session_id) {
      bindOwnerRun(db, {
        taskId: legacyId,
        executorKind: 'cursor-native',
        conversationId: null,
        nativeHandle: state.master_session_id,
      });
    }

    // Do NOT import default fake npm test as required criteria — leave empty for re-freeze
    addWorkUnit(db, {
      taskId: legacyId,
      role: 'migrated',
      laneKey: 'legacy',
      state: status === 'DONE' ? 'passed' : 'pending',
    });

    report.tasksImported += 1;
  }

  return report;
}

/** Export for tests that need to assert conflict detection without apply. */
export function detectIndexConflicts(sourceRoot: string): string[] {
  const index = readJson<{ active_tasks?: string[]; done_tasks?: string[] }>(
    join(sourceRoot, 'tasks', 'index.json'),
  );
  if (!index) return [];
  const active = new Set(index.active_tasks ?? []);
  const conflicts: string[] = [];
  for (const id of index.done_tasks ?? []) {
    if (active.has(id)) conflicts.push(id);
  }
  for (const id of active) {
    const state = readJson<{ status?: string }>(join(sourceRoot, 'tasks', id, 'state.json'));
    if (state?.status === 'DONE') conflicts.push(`${id}:state_done_still_active`);
  }
  return conflicts;
}
