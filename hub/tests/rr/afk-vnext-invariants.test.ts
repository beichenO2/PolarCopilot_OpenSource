import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addCriterion,
  addEvidence,
  addWorkUnit,
  assertCanMarkDone,
  bindCriterionEvidence,
  bindOwnerRun,
  completeTaskIfGatePasses,
  createTask,
  detectIndexConflicts,
  evaluateCompletion,
  findTaskByConversation,
  leaseWorkUnit,
  listActiveTasks,
  migrateFromFileRoot,
  openAfkDb,
  pauseTask,
  repairDoneIndexInvariant,
  transitionTask,
  type AfkDb,
} from '../../src/rr/afk/vnext/index.js';

describe('afk vnext invariants', () => {
  const dbs: AfkDb[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    while (dbs.length) dbs.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function tempDb(): AfkDb {
    const dir = mkdtempSync(join(tmpdir(), 'afk-vnext-'));
    dirs.push(dir);
    const db = openAfkDb(join(dir, 'afk.db'));
    dbs.push(db);
    return db;
  }

  it('DONE task never appears in listActiveTasks', () => {
    const db = tempDb();
    const t = createTask(db, {
      goal: 'x',
      projectRoot: '/p',
      surface: 'ide',
      status: 'PLANNING',
    });
    transitionTask(db, t.task_id, 'RUNNING');
    transitionTask(db, t.task_id, 'VERIFYING');
    transitionTask(db, t.task_id, 'READY_TO_DELIVER');
    addCriterion(db, t.task_id, 'unit tests pass');
    const crit = db.prepare('SELECT criterion_id FROM criteria WHERE task_id = ?').get(t.task_id) as {
      criterion_id: string;
    };
    const ev = addEvidence(db, {
      taskId: t.task_id,
      command: 'npm test',
      exitCode: 0,
      salient: '1 passed',
    });
    bindCriterionEvidence(db, crit.criterion_id, ev);
    const unit = addWorkUnit(db, { taskId: t.task_id, state: 'pending' });
    db.prepare(`UPDATE work_units SET state = 'passed' WHERE unit_id = ?`).run(unit);

    const result = completeTaskIfGatePasses(db, t.task_id);
    expect(result.ok).toBe(true);
    expect(listActiveTasks(db).map((x) => x.task_id)).not.toContain(t.task_id);
  });

  it('refuses DONE without completion gate (direct transition)', () => {
    const db = tempDb();
    const t = createTask(db, { goal: 'x', projectRoot: '/p', surface: 'ide', status: 'READY_TO_DELIVER' });
    const r = transitionTask(db, t.task_id, 'DONE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('gate_failed');
  });

  it('completeTaskIfGatePasses rejects when criteria unmet (legacy doneAfk defect)', () => {
    const db = tempDb();
    const t = createTask(db, { goal: 'x', projectRoot: '/p', surface: 'web', status: 'READY_TO_DELIVER' });
    const report = evaluateCompletion(db, t.task_id);
    expect(report.ok).toBe(false);
    expect(report.gaps.some((g) => g.code === 'required_criteria_unmet')).toBe(true);
    const r = completeTaskIfGatePasses(db, t.task_id);
    expect(r.ok).toBe(false);
    expect(listActiveTasks(db).map((x) => x.task_id)).toContain(t.task_id);
  });

  it('repairDoneIndexInvariant is idempotent when already DONE (markTaskDone early-return class)', () => {
    const db = tempDb();
    const t = createTask(db, { goal: 'x', projectRoot: '/p', surface: 'ide', status: 'DRAFT' });
    const ts = new Date().toISOString();
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run('DONE', ts, t.task_id);
    const a = repairDoneIndexInvariant(db, t.task_id);
    const b = repairDoneIndexInvariant(db, t.task_id);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(listActiveTasks(db).map((x) => x.task_id)).not.toContain(t.task_id);
  });

  it('detects active∧done conflicts in legacy index (live defect regression)', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-legacy-'));
    dirs.push(root);
    mkdirSync(join(root, 'tasks', 't1'), { recursive: true });
    writeFileSync(
      join(root, 'tasks', 'index.json'),
      JSON.stringify({
        active_tasks: ['t1'],
        done_tasks: ['t1'],
        updated_at: new Date().toISOString(),
      }),
    );
    writeFileSync(
      join(root, 'tasks', 't1', 'state.json'),
      JSON.stringify({ status: 'DONE', project_root: '/p', master_session_id: null }),
    );
    const conflicts = detectIndexConflicts(root);
    expect(conflicts.length).toBeGreaterThan(0);

    const db = tempDb();
    const report = migrateFromFileRoot(db, root, { dryRun: true });
    expect(report.conflicts.some((c) => c.includes('active_and_done'))).toBe(true);

    const applied = migrateFromFileRoot(db, root, { dryRun: false });
    expect(applied.tasksImported).toBe(1);
    expect(listActiveTasks(db).map((x) => x.task_id)).not.toContain('t1');
  });

  it('isolates tasks by conversation_id (no cross-task bind)', () => {
    const db = tempDb();
    const a = createTask(db, { goal: 'A', projectRoot: '/proj-a', surface: 'ide' });
    const b = createTask(db, { goal: 'B', projectRoot: '/proj-b', surface: 'ide' });
    bindOwnerRun(db, { taskId: a.task_id, executorKind: 'cursor-native', conversationId: 'conv-a' });
    bindOwnerRun(db, { taskId: b.task_id, executorKind: 'cursor-native', conversationId: 'conv-b' });
    expect(findTaskByConversation(db, 'conv-a', '/proj-a')?.task_id).toBe(a.task_id);
    expect(findTaskByConversation(db, 'conv-b', '/proj-b')?.task_id).toBe(b.task_id);
    expect(findTaskByConversation(db, 'conv-a', '/proj-b')).toBeNull();
  });

  it('enforces single lease owner per work unit', () => {
    const db = tempDb();
    const t = createTask(db, { goal: 'x', projectRoot: '/p', surface: 'ide' });
    const u = addWorkUnit(db, { taskId: t.task_id });
    expect(leaseWorkUnit(db, u, 'lane-1').ok).toBe(true);
    const clash = leaseWorkUnit(db, u, 'lane-2');
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.code).toBe('lease_conflict');
  });

  it('pauseTask only affects that task', () => {
    const db = tempDb();
    const a = createTask(db, { goal: 'A', projectRoot: '/p', surface: 'ide', status: 'RUNNING' });
    const b = createTask(db, { goal: 'B', projectRoot: '/p', surface: 'ide', status: 'RUNNING' });
    pauseTask(db, a.task_id);
    expect(listActiveTasks(db).find((x) => x.task_id === a.task_id)?.status).toBe('PAUSED');
    expect(listActiveTasks(db).find((x) => x.task_id === b.task_id)?.status).toBe('RUNNING');
  });

  it('refuses one evidence fan-out across multiple criteria (hollow-bridge guard)', () => {
    const db = tempDb();
    const t = createTask(db, {
      goal: 'x',
      projectRoot: '/p',
      surface: 'ide',
      status: 'READY_TO_DELIVER',
    });
    addCriterion(db, t.task_id, 'crit A');
    addCriterion(db, t.task_id, 'crit B');
    const report = assertCanMarkDone(t.task_id, {
      db,
      evidence: { command: 'npm test', exitCode: 0, salient: 'ok' },
    });
    expect(report.ok).toBe(false);
    expect(report.gaps.some((g) => g.code === 'stale_or_missing_evidence')).toBe(true);
  });

  it('only one owner run per task', () => {
    const db = tempDb();
    const t = createTask(db, { goal: 'x', projectRoot: '/p', surface: 'web' });
    bindOwnerRun(db, { taskId: t.task_id, executorKind: 'cursor-cli', nativeHandle: 'chat-1' });
    bindOwnerRun(db, { taskId: t.task_id, executorKind: 'cursor-cli', nativeHandle: 'chat-2' });
    const owners = db
      .prepare(`SELECT native_handle FROM runs WHERE task_id = ? AND status = 'owner'`)
      .all(t.task_id) as Array<{ native_handle: string }>;
    expect(owners).toHaveLength(1);
    expect(owners[0].native_handle).toBe('chat-2');
  });
});
