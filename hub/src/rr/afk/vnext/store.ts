import type { AfkDb } from './db.js';
import { newId, nowIso } from './db.js';
import {
  ACTIVE_QUERY_STATUSES,
  LEGAL_TRANSITIONS,
  type AfkCriterionStatus,
  type AfkExecutorKind,
  type AfkSurface,
  type AfkTaskRow,
  type AfkTaskStatus,
  type AfkUnitState,
  type TransitionError,
} from './types.js';

export type Result<T> = { ok: true; value: T } | { ok: false; error: TransitionError };

function fail(code: TransitionError['code'], message: string, detail?: unknown): Result<never> {
  return { ok: false, error: { code, message, detail } };
}

function appendEvent(db: AfkDb, taskId: string | null, kind: string, detail: unknown): void {
  db.prepare(
    'INSERT INTO events(task_id, kind, detail, at) VALUES (?, ?, ?, ?)',
  ).run(taskId, kind, JSON.stringify(detail ?? {}), nowIso());
}

export function createTask(
  db: AfkDb,
  input: {
    taskId?: string;
    goal: string;
    projectRoot: string;
    surface: AfkSurface;
    mode?: 'start' | 'solo';
    status?: AfkTaskStatus;
    priority?: number;
  },
): AfkTaskRow {
  const ts = nowIso();
  const task_id = input.taskId ?? newId('task');
  const status: AfkTaskStatus = input.status ?? 'DRAFT';
  db.prepare(
    `INSERT INTO tasks(task_id, goal, project_root, surface, status, mode, priority, last_scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    task_id,
    input.goal,
    input.projectRoot,
    input.surface,
    status,
    input.mode ?? 'solo',
    input.priority ?? 0,
    ts,
    ts,
  );
  appendEvent(db, task_id, 'task_created', { status, surface: input.surface });
  return getTask(db, task_id)!;
}

export function getTask(db: AfkDb, taskId: string): AfkTaskRow | null {
  return (db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as AfkTaskRow | undefined) ?? null;
}

/** Active/runnable query — DONE never appears. */
export function listActiveTasks(db: AfkDb): AfkTaskRow[] {
  const rows = db.prepare('SELECT * FROM tasks').all() as AfkTaskRow[];
  return rows.filter((r) => ACTIVE_QUERY_STATUSES.has(r.status) && r.status !== 'DONE');
}

export function transitionTask(
  db: AfkDb,
  taskId: string,
  to: AfkTaskStatus,
  opts?: { allowDone?: boolean; reason?: string },
): Result<AfkTaskRow> {
  return db.transaction(() => {
    const task = getTask(db, taskId);
    if (!task) return fail('not_found', `task ${taskId} not found`);
    if (to === 'DONE' && !opts?.allowDone) {
      return fail('gate_failed', 'DONE requires completion gate (allowDone)', { taskId });
    }
    const allowed = LEGAL_TRANSITIONS[task.status];
    if (!allowed.includes(to) && !(to === 'DONE' && opts?.allowDone && task.status === 'READY_TO_DELIVER')) {
      // allowDone from READY_TO_DELIVER is already in LEGAL_TRANSITIONS
      if (!allowed.includes(to)) {
        return fail('illegal_transition', `${task.status} -> ${to}`, { from: task.status, to });
      }
    }
    if (to === 'DONE') {
      // Invariant: must not already be DONE with conflicting active semantics
      const ts = nowIso();
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(to, ts, taskId);
      // Close owner run
      db.prepare(
        `UPDATE runs SET status = 'closed', updated_at = ? WHERE task_id = ? AND status = 'owner'`,
      ).run(ts, taskId);
      appendEvent(db, taskId, 'task_done', { reason: opts?.reason ?? 'gate', previous: task.status });
      const next = getTask(db, taskId)!;
      // Hard invariant check inside same transaction
      const activeIds = listActiveTasks(db).map((t) => t.task_id);
      if (activeIds.includes(taskId)) {
        throw new Error('invariant_violation: DONE task still in active query');
      }
      return { ok: true as const, value: next };
    }
    const ts = nowIso();
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(to, ts, taskId);
    appendEvent(db, taskId, 'task_transition', { from: task.status, to, reason: opts?.reason });
    return { ok: true as const, value: getTask(db, taskId)! };
  })();
}

export function bindOwnerRun(
  db: AfkDb,
  input: {
    taskId: string;
    executorKind: AfkExecutorKind;
    conversationId?: string | null;
    nativeHandle?: string | null;
    serviceId?: string | null;
    pid?: number | null;
  },
): Result<{ run_id: string }> {
  return db.transaction(() => {
    const task = getTask(db, input.taskId);
    if (!task) return fail('not_found', `task ${input.taskId} not found`);
    if (task.status === 'DONE' || task.status === 'CANCELLED') {
      return fail('invariant', 'cannot bind run to terminal task');
    }
    const ts = nowIso();
    db.prepare(
      `UPDATE runs SET status = 'superseded', updated_at = ? WHERE task_id = ? AND status = 'owner'`,
    ).run(ts, input.taskId);
    const run_id = newId('run');
    db.prepare(
      `INSERT INTO runs(run_id, task_id, executor_kind, native_handle, conversation_id, pid, service_id, heartbeat_at, attempt, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'owner', ?, ?)`,
    ).run(
      run_id,
      input.taskId,
      input.executorKind,
      input.nativeHandle ?? null,
      input.conversationId ?? null,
      input.pid ?? null,
      input.serviceId ?? null,
      ts,
      ts,
      ts,
    );
    appendEvent(db, input.taskId, 'run_bound', { run_id, executor: input.executorKind });
    return { ok: true as const, value: { run_id } };
  })();
}

export function findTaskByConversation(
  db: AfkDb,
  conversationId: string,
  projectRoot?: string,
): AfkTaskRow | null {
  // Prefer owner run; fall back to any run (DONE closes owner) so stop-hook can no-op correctly.
  const sql = projectRoot
    ? `SELECT t.* FROM tasks t
       JOIN runs r ON r.task_id = t.task_id
       WHERE r.conversation_id = ? AND t.project_root = ?
       ORDER BY CASE r.status WHEN 'owner' THEN 0 ELSE 1 END, r.updated_at DESC
       LIMIT 1`
    : `SELECT t.* FROM tasks t
       JOIN runs r ON r.task_id = t.task_id
       WHERE r.conversation_id = ?
       ORDER BY CASE r.status WHEN 'owner' THEN 0 ELSE 1 END, r.updated_at DESC
       LIMIT 1`;
  const row = (
    projectRoot
      ? db.prepare(sql).get(conversationId, projectRoot)
      : db.prepare(sql).get(conversationId)
  ) as AfkTaskRow | undefined;
  return row ?? null;
}

export function addCriterion(
  db: AfkDb,
  taskId: string,
  text: string,
  required = true,
): string {
  const id = newId('crit');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO criteria(criterion_id, task_id, text, required, status, evidence_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
  ).run(id, taskId, text, required ? 1 : 0, ts, ts);
  return id;
}

export function addEvidence(
  db: AfkDb,
  input: {
    taskId: string;
    command: string;
    exitCode: number;
    salient: string;
    producerRole?: string;
    artifactDigest?: string | null;
  },
): string {
  const id = newId('ev');
  db.prepare(
    `INSERT INTO evidence(evidence_id, task_id, command, exit_code, salient, timestamp, artifact_digest, producer_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.command,
    input.exitCode,
    input.salient,
    nowIso(),
    input.artifactDigest ?? null,
    input.producerRole ?? 'unknown',
  );
  return id;
}

export function bindCriterionEvidence(
  db: AfkDb,
  criterionId: string,
  evidenceId: string,
  status: AfkCriterionStatus = 'pass',
): Result<void> {
  return db.transaction(() => {
    const crit = db.prepare('SELECT * FROM criteria WHERE criterion_id = ?').get(criterionId) as
      | { task_id: string }
      | undefined;
    if (!crit) return fail('not_found', 'criterion not found');
    const ev = db.prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(evidenceId) as
      | { task_id: string }
      | undefined;
    if (!ev) return fail('not_found', 'evidence not found');
    if (crit.task_id !== ev.task_id) {
      return fail('invariant', 'criterion/evidence task mismatch', { criterionId, evidenceId });
    }
    const ts = nowIso();
    db.prepare(
      'UPDATE criteria SET status = ?, evidence_id = ?, updated_at = ? WHERE criterion_id = ?',
    ).run(status, evidenceId, ts, criterionId);
    return { ok: true as const, value: undefined };
  })();
}

export function addWorkUnit(
  db: AfkDb,
  input: {
    taskId: string;
    role?: string;
    laneKey?: string;
    allowedWrites?: string[];
    verifyCmd?: string | null;
    parentId?: string | null;
    state?: AfkUnitState;
  },
): string {
  const id = newId('unit');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO work_units(unit_id, task_id, parent_id, state, role, lane_key, allowed_writes, verify_cmd, attempt, lease_owner, lease_expiry, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.taskId,
    input.parentId ?? null,
    input.state ?? 'pending',
    input.role ?? 'implementer',
    input.laneKey ?? 'main',
    JSON.stringify(input.allowedWrites ?? []),
    input.verifyCmd ?? null,
    ts,
    ts,
  );
  return id;
}

export function leaseWorkUnit(
  db: AfkDb,
  unitId: string,
  owner: string,
  ttlMs = 600_000,
): Result<void> {
  return db.transaction(() => {
    const unit = db.prepare('SELECT * FROM work_units WHERE unit_id = ?').get(unitId) as
      | {
          state: string;
          lease_owner: string | null;
          lease_expiry: string | null;
        }
      | undefined;
    if (!unit) return fail('not_found', 'unit not found');
    const now = Date.now();
    if (
      unit.lease_owner &&
      unit.lease_owner !== owner &&
      unit.lease_expiry &&
      Date.parse(unit.lease_expiry) > now
    ) {
      return fail('lease_conflict', 'unit leased by another owner', {
        owner: unit.lease_owner,
        expiry: unit.lease_expiry,
      });
    }
    const expiry = new Date(now + ttlMs).toISOString();
    const ts = nowIso();
    db.prepare(
      `UPDATE work_units SET lease_owner = ?, lease_expiry = ?, state = 'leased', updated_at = ? WHERE unit_id = ?`,
    ).run(owner, expiry, ts, unitId);
    return { ok: true as const, value: undefined };
  })();
}

export function repairDoneIndexInvariant(db: AfkDb, taskId: string): Result<AfkTaskRow> {
  /** Idempotent: if status is DONE, ensure not in active semantics (no-op on SQLite query). */
  const task = getTask(db, taskId);
  if (!task) return fail('not_found', 'task not found');
  if (task.status !== 'DONE') return fail('invariant', 'task is not DONE');
  const active = listActiveTasks(db).some((t) => t.task_id === taskId);
  if (active) return fail('invariant', 'DONE task still active — schema bug');
  appendEvent(db, taskId, 'repair_done_noop', {});
  return { ok: true, value: task };
}

export function pauseTask(db: AfkDb, taskId: string): Result<AfkTaskRow> {
  return transitionTask(db, taskId, 'PAUSED', { reason: 'pause' });
}
