import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initTaskArtifacts,
  markTaskDone,
  readIndex,
  readState,
  readSummary,
  writeIndex,
  writeState,
} from '../../src/rr/afk/index.js';
import {
  armAfk,
  doneAfk,
  haltAfkOrchestrator,
  oneClickAfk,
  pauseAfk,
  readAfkStatus,
  resumeAfk,
  tickAfk,
} from '../../src/rr/afk-service.js';
import * as budgetGate from '../../src/rr/afk/budget-gate.js';
import * as polarBudget from '../../src/rr/polar-budget.js';
import * as polarService from '../../src/rr/orchestrator/polar-service.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('rr afk multi-active', () => {
  const roots: string[] = [];
  const envBackup = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function useTempAfkRoot(projectRoot: string): { afkRoot: string; legacyAfkRoot: string } {
    const afkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-multi-ssot-'));
    const legacyAfkRoot = join(projectRoot, 'legacy-afk');
    roots.push(projectRoot, afkRoot);
    process.env.RR_AFK_ROOT = afkRoot;
    process.env.PC_PROJECT_DIR = projectRoot;
    writeFileSync(join(projectRoot, '.rr-orchestrator.json'), JSON.stringify({
      projectRoot,
      afkRoot: legacyAfkRoot,
      statePath: join(projectRoot, 'state.json'),
    }), 'utf8');
    return { afkRoot, legacyAfkRoot };
  }

  it('writeIndex preserves done_tasks when callers omit the field', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-done-preserve-'));
    useTempAfkRoot(projectRoot);

    writeIndex({
      active_tasks: ['task-a'],
      done_tasks: ['finished-1', 'finished-2'],
      updated_at: new Date().toISOString(),
    });

    writeIndex({ active_tasks: ['task-a', 'task-b'], updated_at: new Date().toISOString() });

    const index = readIndex();
    expect(index.active_tasks.sort()).toEqual(['task-a', 'task-b']);
    expect(index.done_tasks?.sort()).toEqual(['finished-1', 'finished-2']);
  });

  it('armAfk allows a second different task while legacy ACTIVE exists', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-arm-second-'));
    const { legacyAfkRoot } = useTempAfkRoot(projectRoot);
    mkdirSync(legacyAfkRoot, { recursive: true });

    initTaskArtifacts({
      taskId: 'first-task',
      projectRoot,
      masterSessionId: 'sess-1',
      activate: true,
    });
    await armAfk({ taskSlug: 'first-task', projectRoot, force: true });

    initTaskArtifacts({
      taskId: 'second-task',
      projectRoot,
      masterSessionId: 'sess-2',
      activate: false,
    });

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 8,
      reason: 'test',
    });

    await expect(armAfk({ taskSlug: 'second-task', projectRoot })).resolves.toMatchObject({ armed: true });

    const index = readIndex();
    expect(index.active_tasks.sort()).toEqual(['first-task', 'second-task']);
    expect(existsSync(join(legacyAfkRoot, 'ACTIVE'))).toBe(true);
  });

  it('armAfk rejects duplicate same task without force', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-arm-dup-'));
    useTempAfkRoot(projectRoot);

    initTaskArtifacts({
      taskId: 'dup-task',
      projectRoot,
      masterSessionId: null,
      activate: true,
    });
    await armAfk({ taskSlug: 'dup-task', projectRoot, force: true });

    await expect(armAfk({ taskSlug: 'dup-task', projectRoot })).rejects.toThrow('afk_already_active');
  });

  it('pauseAfk on one task leaves sibling active in index', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-pause-isolate-'));
    useTempAfkRoot(projectRoot);

    initTaskArtifacts({ taskId: 'keep-active', projectRoot, masterSessionId: null, activate: true });
    initTaskArtifacts({ taskId: 'pause-me', projectRoot, masterSessionId: null, activate: true });

    pauseAfk('pause-me');

    expect(readSummary('pause-me')?.status).toBe('PAUSED');
    expect(readIndex().active_tasks).toEqual(['keep-active']);
  });

  it('readAfkStatus activeTasks lists all active tasks with mode and projectRoot', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-status-multi-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-status-store-')));
    roots.push(store.root);

    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });
    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 8,
      reason: 'test',
    });
    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: true,
      reason: 'test',
      recommended_jobs: 8,
      budget: { ok: true, recommended_jobs: 8, reason: 'test' },
    });

    const masterA = store.register({ name: 'Master A' }).session;
    const masterB = store.register({ name: 'Master B' }).session;

    await oneClickAfk(store, {
      taskSlug: 'multi-a',
      projectRoot,
      sessionId: masterA.sessionId,
      mode: 'solo',
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });
    await oneClickAfk(store, {
      taskSlug: 'multi-b',
      projectRoot,
      sessionId: masterB.sessionId,
      mode: 'go',
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });

    const status = await readAfkStatus(projectRoot);
    expect(status.activeTasks.map((item) => item.taskId).sort()).toEqual(['multi-a', 'multi-b']);
    expect(status.activeTasks.find((item) => item.taskId === 'multi-a')).toMatchObject({
      masterSessionId: masterA.sessionId,
      mode: 'solo',
      projectRoot,
      paused: false,
      done: false,
    });
    expect(status.activeTasks.find((item) => item.taskId === 'multi-b')).toMatchObject({
      masterSessionId: masterB.sessionId,
      mode: 'go',
      projectRoot,
    });
  });

  it('tickAfk without taskId injects all active tasks when under budget cap', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-tick-all-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-tick-all-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 8,
      reason: 'test',
    });

    const masterA = store.register({ name: 'Tick A' }).session;
    const masterB = store.register({ name: 'Tick B' }).session;

    for (const [taskId, master] of [['tick-a', masterA], ['tick-b', masterB]] as const) {
      initTaskArtifacts({ taskId, projectRoot, masterSessionId: master.sessionId, activate: true });
      writeState(taskId, {
        ...readSummary(taskId)!,
        status: 'RUNNING',
        master_session_id: master.sessionId,
        project_root: projectRoot,
        current_unit: 'U1',
        plan_revision: 0,
        loop: 1,
        max_loops: 40,
        allowlist: [],
        permission_request: null,
        last_command: null,
        last_verification: null,
        human_action_hint: null,
        updated_at: new Date().toISOString(),
      });
    }

    const result = await tickAfk(store);
    expect('ticks' in result).toBe(true);
    if ('ticks' in result) {
      expect(result.ticks.map((item) => item.taskId).sort()).toEqual(['tick-a', 'tick-b']);
    }

    for (const master of [masterA, masterB]) {
      const history = store.getHistory(master.sessionId);
      expect(history.some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(true);
    }
  });

  it('tickAfk without taskId throttles inject to cap=1 when budget unavailable', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-tick-cap-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-tick-cap-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: false,
      reason: 'budget_unavailable',
      recommended_jobs: 1,
    });

    const masterA = store.register({ name: 'Cap A' }).session;
    const masterB = store.register({ name: 'Cap B' }).session;

    for (const [taskId, master, updatedAt] of [
      ['cap-a', masterA, '2026-01-01T00:00:00.000Z'],
      ['cap-b', masterB, '2026-01-02T00:00:00.000Z'],
    ] as const) {
      initTaskArtifacts({ taskId, projectRoot, masterSessionId: master.sessionId, activate: true });
      writeState(taskId, {
        ...readSummary(taskId)!,
        status: 'RUNNING',
        master_session_id: master.sessionId,
        project_root: projectRoot,
        current_unit: 'U1',
        plan_revision: 0,
        loop: 1,
        max_loops: 40,
        allowlist: [],
        permission_request: null,
        last_command: null,
        last_verification: null,
        human_action_hint: null,
        updated_at: updatedAt,
      });
    }

    const result = await tickAfk(store);
    expect(result.ticks).toMatchObject([
      { taskId: 'cap-a', sessionId: masterA.sessionId },
    ]);
    expect(result.deferred).toEqual(['cap-b']);
    expect(store.getHistory(masterA.sessionId).some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(true);
    expect(store.getHistory(masterB.sessionId).some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(false);
  });

  it('tickAfk without taskId throttles to recommended_jobs=3 with many actives', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-tick-inject-3-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-tick-inject-3-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 3,
      reason: 'test',
    });

    const masters = Array.from({ length: 5 }, (_, i) => store.register({ name: `Inject ${i}` }).session);
    for (let i = 0; i < 5; i += 1) {
      const taskId = `inject-${i}`;
      initTaskArtifacts({ taskId, projectRoot, masterSessionId: masters[i]!.sessionId, activate: true });
      writeState(taskId, {
        ...readSummary(taskId)!,
        status: 'RUNNING',
        master_session_id: masters[i]!.sessionId,
        project_root: projectRoot,
        current_unit: 'U1',
        plan_revision: 0,
        loop: 1,
        max_loops: 40,
        allowlist: [],
        permission_request: null,
        last_command: null,
        last_verification: null,
        human_action_hint: null,
        updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
      });
    }

    const result = await tickAfk(store);
    expect(result.ticks).toHaveLength(3);
    expect(result.deferred).toHaveLength(2);
  });

  it('armAfk binds masterSessionId per task without stomping global config', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-arm-master-'));
    const { legacyAfkRoot } = useTempAfkRoot(projectRoot);
    mkdirSync(legacyAfkRoot, { recursive: true });
    const configPath = join(projectRoot, '.rr-orchestrator.json');
    writeFileSync(configPath, JSON.stringify({
      projectRoot,
      afkRoot: legacyAfkRoot,
      statePath: join(projectRoot, 'state.json'),
      masterSessionId: 'global-master-keep',
    }), 'utf8');

    initTaskArtifacts({
      taskId: 'arm-master-a',
      projectRoot,
      masterSessionId: 'sess-a',
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'arm-master-b',
      projectRoot,
      masterSessionId: null,
      activate: false,
    });

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 8,
      reason: 'test',
    });

    await armAfk({ taskSlug: 'arm-master-a', projectRoot, force: true, masterSessionId: 'sess-a' });
    await armAfk({ taskSlug: 'arm-master-b', projectRoot, masterSessionId: 'sess-b' });

    expect(JSON.parse(readFileSync(configPath, 'utf8')).masterSessionId).toBe('global-master-keep');
    expect(readState('arm-master-b')?.master_session_id).toBe('sess-b');
    expect(readIndex().active_tasks.sort()).toEqual(['arm-master-a', 'arm-master-b']);
  });

  it('tickAfk with taskId still ticks only that task', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-tick-one-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-tick-one-store-')));
    roots.push(store.root);

    const masterA = store.register({ name: 'Only A' }).session;
    const masterB = store.register({ name: 'Only B' }).session;

    for (const [taskId, master] of [['only-a', masterA], ['only-b', masterB]] as const) {
      initTaskArtifacts({ taskId, projectRoot, masterSessionId: master.sessionId, activate: true });
      writeState(taskId, {
        ...readSummary(taskId)!,
        status: 'RUNNING',
        master_session_id: master.sessionId,
        project_root: projectRoot,
        current_unit: 'U1',
        plan_revision: 0,
        loop: 1,
        max_loops: 40,
        allowlist: [],
        permission_request: null,
        last_command: null,
        last_verification: null,
        human_action_hint: null,
        updated_at: new Date().toISOString(),
      });
    }

    const tick = await tickAfk(store, 'only-a');
    expect(tick).toMatchObject({ taskId: 'only-a', sessionId: masterA.sessionId });
    expect(store.getHistory(masterA.sessionId).some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(true);
    expect(store.getHistory(masterB.sessionId).some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(false);
  });

  it('persists done_tasks in index.json on disk', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-done-disk-'));
    const { afkRoot } = useTempAfkRoot(projectRoot);

    writeIndex({
      active_tasks: [],
      done_tasks: ['archived-task'],
      updated_at: new Date().toISOString(),
    });
    writeIndex({ active_tasks: ['live-task'], updated_at: new Date().toISOString() });

    const raw = JSON.parse(readFileSync(join(afkRoot, 'tasks', 'index.json'), 'utf8')) as {
      active_tasks: string[]
      done_tasks: string[]
    };
    expect(raw.active_tasks).toEqual(['live-task']);
    expect(raw.done_tasks).toEqual(['archived-task']);
  });

  it('markTaskDone moves task from active_tasks to done_tasks', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-done-producer-'));
    useTempAfkRoot(projectRoot);

    initTaskArtifacts({
      taskId: 'finish-me',
      projectRoot,
      masterSessionId: 'sess-done',
      activate: true,
    });
    expect(readIndex().active_tasks).toEqual(['finish-me']);

    const state = markTaskDone('finish-me');
    expect(state?.status).toBe('DONE');
    expect(readIndex().active_tasks).toEqual([]);
    expect(readIndex().done_tasks).toEqual(['finish-me']);
    expect(readSummary('finish-me')?.status).toBe('DONE');
  });

  it('doneAfk on one task leaves sibling active and frees admission slot', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-done-sibling-'));
    useTempAfkRoot(projectRoot);

    initTaskArtifacts({ taskId: 'done-a', projectRoot, masterSessionId: 'sess-a', activate: true });
    initTaskArtifacts({ taskId: 'done-b', projectRoot, masterSessionId: 'sess-b', activate: true });
    expect(readIndex().active_tasks.sort()).toEqual(['done-a', 'done-b']);

    const result = doneAfk('done-a');
    expect(result.done.task_id).toBe('done-a');
    expect(result.done.status).toBe('DONE');
    expect(result.index.active_tasks).toEqual(['done-b']);
    expect(result.index.done_tasks).toContain('done-a');
    expect(readSummary('done-b')?.status).not.toBe('DONE');
  });

  it('haltAfkOrchestrator pauses all tasks and clears active_tasks', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-halt-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-halt-store-')));
    roots.push(store.root);

    initTaskArtifacts({ taskId: 'halt-a', projectRoot, masterSessionId: null, activate: true });
    initTaskArtifacts({ taskId: 'halt-b', projectRoot, masterSessionId: null, activate: true });

    vi.spyOn(polarService, 'haltOrchestratorService').mockResolvedValue({
      enabled: false,
      polarprocess: null,
      running: false,
    });

    const result = await haltAfkOrchestrator();
    expect(result.index.active_tasks).toEqual([]);
    expect(result.paused.sort()).toEqual(['halt-a', 'halt-b']);
    expect(readSummary('halt-a')?.status).toBe('PAUSED');
    expect(readSummary('halt-b')?.status).toBe('PAUSED');

    await expect(tickAfk(store)).rejects.toThrow('afk_task_not_found');
  });

  it('oneClickAfk admits fleet of 10 when budget recommended_jobs is 8 (fleet max rule)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-fleet-10-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-fleet-10-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 8,
      reason: 'test',
    });
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });
    const spawnEnqueue = vi.fn();

    for (let i = 0; i < 10; i += 1) {
      const master = store.register({ name: `Fleet ${i}` }).session;
      await oneClickAfk(store, {
        taskSlug: `fleet-task-${i}`,
        projectRoot,
        sessionId: master.sessionId,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }, { spawnEnqueue });
    }

    expect(readIndex().active_tasks).toHaveLength(10);
    expect(spawnEnqueue).not.toHaveBeenCalled();
  });

  it('oneClickAfk admits fleet of 10 when budget recommended_jobs is 10', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-fleet-10b-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-fleet-10b-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 10,
      reason: 'test',
    });
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });

    for (let i = 0; i < 10; i += 1) {
      const master = store.register({ name: `FleetB ${i}` }).session;
      await oneClickAfk(store, {
        taskSlug: `fleet-b-${i}`,
        projectRoot,
        sessionId: master.sessionId,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }, { spawnEnqueue: vi.fn() });
    }

    expect(readIndex().active_tasks).toHaveLength(10);
  });

  it('resumeAfk rejects when at admission cap without force', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-resume-cap-'));
    useTempAfkRoot(projectRoot);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 10,
      reason: 'test',
    });

    for (let i = 0; i < 10; i += 1) {
      initTaskArtifacts({
        taskId: `resume-cap-${i}`,
        projectRoot,
        masterSessionId: `sess-${i}`,
        activate: true,
      });
    }
    expect(readIndex().active_tasks).toHaveLength(10);

    pauseAfk('resume-cap-0');
    expect(readIndex().active_tasks).toHaveLength(9);

    initTaskArtifacts({
      taskId: 'resume-cap-fill',
      projectRoot,
      masterSessionId: 'sess-fill',
      activate: true,
    });
    expect(readIndex().active_tasks).toHaveLength(10);

    await expect(resumeAfk('resume-cap-0')).rejects.toThrow('afk_budget_capacity');
    expect(readSummary('resume-cap-0')?.status).toBe('PAUSED');
    expect(readIndex().active_tasks).toHaveLength(10);

    await resumeAfk('resume-cap-0', { force: true });
    expect(readSummary('resume-cap-0')?.status).toBe('READY');
    expect(readIndex().active_tasks).toHaveLength(11);
  });

  it('oneClickAfk rejects 11th task with afk_budget_capacity when cap is 10', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-fleet-11-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-fleet-11-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 10,
      reason: 'test',
    });
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });

    for (let i = 0; i < 10; i += 1) {
      const master = store.register({ name: `Cap ${i}` }).session;
      await oneClickAfk(store, {
        taskSlug: `cap-fleet-${i}`,
        projectRoot,
        sessionId: master.sessionId,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }, { spawnEnqueue: vi.fn() });
    }

    const extra = store.register({ name: 'Cap 11' }).session;
    await expect(oneClickAfk(store, {
      taskSlug: 'cap-fleet-11',
      projectRoot,
      sessionId: extra.sessionId,
      spawnIfNeeded: false,
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() })).rejects.toThrow('afk_budget_capacity');
  });

  it('oneClickAfk allows up to 10 tasks when budget is unavailable (admission floor)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-budget-offline-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-budget-offline-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: false,
      reason: 'budget_unavailable',
      recommended_jobs: 1,
    });
    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: true,
      reason: 'within_recommended_jobs',
      recommended_jobs: 1,
      budget: { ok: false, reason: 'budget_unavailable', recommended_jobs: 1 },
    });

    const masterA = store.register({ name: 'Offline A' }).session;
    await oneClickAfk(store, {
      taskSlug: 'offline-task-a',
      projectRoot,
      sessionId: masterA.sessionId,
      spawnIfNeeded: false,
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });

    const masterB = store.register({ name: 'Offline B' }).session;
    await expect(oneClickAfk(store, {
      taskSlug: 'offline-task-b',
      projectRoot,
      sessionId: masterB.sessionId,
      spawnIfNeeded: false,
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() })).resolves.toMatchObject({ ok: true });

    expect(readIndex().active_tasks.sort()).toEqual(['offline-task-a', 'offline-task-b']);

    for (let i = 2; i < 10; i += 1) {
      const master = store.register({ name: `Offline ${i}` }).session;
      await oneClickAfk(store, {
        taskSlug: `offline-task-${i}`,
        projectRoot,
        sessionId: master.sessionId,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }, { spawnEnqueue: vi.fn() });
    }
    expect(readIndex().active_tasks).toHaveLength(10);
  });

  it('oneClickAfk rejects afk_budget_capacity when at cap without force', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-capacity-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-capacity-store-')));
    roots.push(store.root);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 10,
      reason: 'test',
    });
    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: true,
      reason: 'within_recommended_jobs',
      recommended_jobs: 10,
      budget: { ok: true, recommended_jobs: 10, reason: 'test' },
    });
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });

    for (let i = 0; i < 10; i += 1) {
      const master = store.register({ name: `Cap ${i}` }).session;
      await oneClickAfk(store, {
        taskSlug: `cap-task-${i}`,
        projectRoot,
        sessionId: master.sessionId,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }, { spawnEnqueue: vi.fn() });
    }

    const masterB = store.register({ name: 'Cap B' }).session;
    await expect(oneClickAfk(store, {
      taskSlug: 'cap-task-b',
      projectRoot,
      sessionId: masterB.sessionId,
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() })).rejects.toThrow('afk_budget_capacity');
  });
});
