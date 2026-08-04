import type { AfkDb } from './db.js';
import { nowIso, newId } from './db.js';
import {
  bindOwnerRun,
  createTask,
  findTaskByConversation,
  getTask,
  transitionTask,
} from './store.js';
import { evaluateCompletion } from './completion-gate.js';
import type { AfkTaskRow } from './types.js';

export interface IdeBindInput {
  conversationId: string;
  projectRoot: string;
  goal?: string;
  mode?: 'start' | 'solo';
  taskId?: string;
}

export function bindIdeConversation(db: AfkDb, input: IdeBindInput): AfkTaskRow {
  const existing = findTaskByConversation(db, input.conversationId, input.projectRoot);
  if (existing) return existing;

  const task =
    (input.taskId && getTask(db, input.taskId)) ||
    createTask(db, {
      taskId: input.taskId,
      goal: input.goal ?? 'ide-afk',
      projectRoot: input.projectRoot,
      surface: 'ide',
      mode: input.mode ?? 'solo',
      status: 'PLANNING',
    });

  bindOwnerRun(db, {
    taskId: task.task_id,
    executorKind: 'cursor-native',
    conversationId: input.conversationId,
  });
  transitionTask(db, task.task_id, 'RUNNING', { reason: 'ide_bind' });
  return getTask(db, task.task_id)!;
}

export function registerNativeLane(
  db: AfkDb,
  input: {
    taskId: string;
    laneKey: string;
    role: string;
    nativeSubagentId: string;
  },
): string {
  const id = newId('bind');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO agent_bindings(binding_id, task_id, lane_key, role, native_subagent_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.taskId, input.laneKey, input.role, input.nativeSubagentId, ts, ts);
  return id;
}

export function resolveNativeLane(
  db: AfkDb,
  taskId: string,
  laneKey: string,
): { native_subagent_id: string | null; role: string } | null {
  const row = db
    .prepare(
      `SELECT native_subagent_id, role FROM agent_bindings
       WHERE task_id = ? AND lane_key = ? ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(taskId, laneKey) as { native_subagent_id: string | null; role: string } | undefined;
  return row ?? null;
}

/** CLI/hook: should stop hook emit followup? */
export function gateCheckForConversation(
  db: AfkDb,
  conversationId: string,
  cwd?: string,
): { ok: boolean; task_id: string | null; status: string | null; gaps?: unknown } {
  const task = findTaskByConversation(db, conversationId, cwd);
  if (!task) return { ok: true, task_id: null, status: null }; // unbound → do not loop
  if (task.status === 'DONE' || task.status === 'CANCELLED' || task.status === 'PAUSED' || task.status === 'NEEDS_HUMAN') {
    return { ok: true, task_id: task.task_id, status: task.status };
  }
  if (task.status === 'READY_TO_DELIVER' || task.status === 'VERIFYING') {
    const report = evaluateCompletion(db, task.task_id);
    return { ok: report.ok, task_id: task.task_id, status: task.status, gaps: report.gaps };
  }
  // Still running/planning → continue
  return { ok: false, task_id: task.task_id, status: task.status };
}
