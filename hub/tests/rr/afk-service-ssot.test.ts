import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initTaskArtifacts,
  readSummary,
  writeState,
} from '../../src/rr/afk/index.js';
import { grantTemporaryPaths } from '../../src/rr/afk/grant.js';
import * as budgetGate from '../../src/rr/afk/budget-gate.js';
import * as polarBudget from '../../src/rr/polar-budget.js';
import {
  buildInitialInjectPrompt,
  normalizeAfkMode,
  oneClickAfk,
  pauseAfk,
  readAfkStatus,
  readAfkSummaryList,
  readDecisionsReport,
  resumeAfk,
  setTaskHeartbeat,
  tickAfk,
} from '../../src/rr/afk-service.js';
import * as orchestratorConfig from '../../src/rr/orchestrator/config.js';
import * as polarService from '../../src/rr/orchestrator/polar-service.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('rr afk service ssot', () => {
  const roots: string[] = [];
  const envBackup = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function useTempAfkRoot(projectRoot: string): string {
    const afkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-ssot-'));
    roots.push(projectRoot, afkRoot);
    process.env.RR_AFK_ROOT = afkRoot;
    process.env.PC_PROJECT_DIR = projectRoot;
    writeFileSync(join(projectRoot, '.rr-orchestrator.json'), JSON.stringify({
      projectRoot,
      afkRoot: join(projectRoot, 'legacy-afk'),
      statePath: join(projectRoot, 'state.json'),
    }), 'utf8');
    return afkRoot;
  }

  it('oneClickAfk initializes task artifacts, spawns master, and injects first prompt', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-oneclick-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-store-')));
    roots.push(store.root);

    const spawnEnqueue = vi.fn(async () => ({ jobId: 'job-1' }));
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const result = await oneClickAfk(store, {
      taskSlug: 'knowlever-solo',
      projectRoot,
      startOrchestrator: false,
    }, { spawnEnqueue });

    expect(result.sessionId).toBeTruthy();
    expect(result.armed).toMatchObject({
      taskId: 'knowlever-solo',
      masterSessionId: result.sessionId,
      activated: true,
    });
    expect(spawnEnqueue).toHaveBeenCalledOnce();

    const summary = readSummary('knowlever-solo');
    expect(summary?.status).toBe('READY');
    expect(summary?.master_session_id).toBe(result.sessionId);

    const history = store.getHistory(result.sessionId);
    expect(history.some((msg) => msg.content.includes('【Rr AFK · 首条注入】'))).toBe(true);
    expect(store.getSession(result.sessionId).title).toBe('AFK · knowlever-solo');
    expect(store.getSession(result.sessionId).afkTaskId).toBe('knowlever-solo');
  });

  it('oneClickAfk throws budget_spawn_deferred when spawn gate blocks', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-budget-block-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-budget-store-')));
    roots.push(store.root);

    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: false,
      reason: 'lease capacity full',
      recommended_jobs: 1,
      budget: { ok: false, reason: 'budget_unavailable', recommended_jobs: 1 },
    });

    await expect(oneClickAfk(store, {
      taskSlug: 'blocked-task',
      projectRoot,
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() })).rejects.toThrow('budget_spawn_deferred:lease capacity full');
  });

  it('oneClickAfk releases budget lease after spawn enqueue', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-budget-lease-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-lease-store-')));
    roots.push(store.root);

    const releaseSpy = vi.spyOn(polarBudget, 'releasePolarBudgetLease').mockResolvedValue(true);

    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: true,
      reason: 'lease_acquired',
      recommended_jobs: 1,
      budget: { ok: true, recommended_jobs: 1, reason: 'warm' },
      leaseId: 'lease-afk-1',
    });

    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const spawnEnqueue = vi.fn(async () => ({ jobId: 'job-lease' }));
    await oneClickAfk(store, {
      taskSlug: 'lease-task',
      projectRoot,
      startOrchestrator: false,
    }, { spawnEnqueue });

    expect(spawnEnqueue).toHaveBeenCalledOnce();
    expect(releaseSpy).toHaveBeenCalledWith('lease-afk-1');
  });

  it('oneClickAfk reuses existing master and still binds afkTaskId', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-reuse-master-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-reuse-store-')));
    roots.push(store.root);

    const existing = store.register({ name: 'Existing Master' }).session;
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const spawnEnqueue = vi.fn(async () => ({ jobId: 'should-not-run' }));
    const result = await oneClickAfk(store, {
      taskSlug: 'reuse-task',
      projectRoot,
      sessionId: existing.sessionId,
      startOrchestrator: false,
    }, { spawnEnqueue });

    expect(result.sessionId).toBe(existing.sessionId);
    expect(spawnEnqueue).not.toHaveBeenCalled();
    expect(store.getSession(existing.sessionId).afkTaskId).toBe('reuse-task');
  });

  it('grants temporary paths for NEEDS_HUMAN tasks without external cli', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-grant-'));
    useTempAfkRoot(projectRoot);

    initTaskArtifacts({
      taskId: 'knowlever-solo',
      projectRoot,
      masterSessionId: 'sess-1',
    });
    writeState('knowlever-solo', {
      ...readSummary('knowlever-solo')!,
      status: 'NEEDS_HUMAN',
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U11',
        plan_revision: 1,
        paths: ['tests/a.test.ts'],
      },
      master_session_id: 'sess-1',
      project_root: projectRoot,
      current_unit: 'U11',
      plan_revision: 1,
      loop: 0,
      max_loops: 40,
      allowlist: [],
      last_command: null,
      last_verification: null,
      human_action_hint: 'review',
      updated_at: new Date().toISOString(),
    });

    const result = grantTemporaryPaths('knowlever-solo', ['tests/a.test.ts']);
    expect(result).toMatchObject({
      taskId: 'knowlever-solo',
      status: 'READY',
      grantedPaths: ['tests/a.test.ts'],
      usesRemaining: 1,
    });
    expect(readSummary('knowlever-solo')?.permission_request).toBeNull();
    expect(readSummary('knowlever-solo')?.allowlist).toEqual(['tests/a.test.ts']);
  });

  it('tick injects continuation prompt to bound master session', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-tick-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-tick-store-')));
    roots.push(store.root);

    const main = store.register({ name: 'AFK Master' }).session;
    initTaskArtifacts({
      taskId: 'tick-task',
      projectRoot,
      masterSessionId: main.sessionId,
    });
    writeState('tick-task', {
      ...readSummary('tick-task')!,
      status: 'RUNNING',
      master_session_id: main.sessionId,
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

    const tick = tickAfk(store, 'tick-task');
    expect(tick.sessionId).toBe(main.sessionId);
    const history = store.getHistory(main.sessionId);
    expect(history.some((msg) => msg.content.includes('【Rr AFK · 续跑】'))).toBe(true);
  });

  it('readAfkStatus merges ssot summaries with legacy-compatible fields', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-status-ssot-'));
    useTempAfkRoot(projectRoot);
    initTaskArtifacts({
      taskId: 'active-task',
      projectRoot,
      masterSessionId: 'sess-main',
    });

    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });

    const status = await readAfkStatus(projectRoot);
    expect(status.taskId).toBe('active-task');
    expect(status.summaries.some((item) => item.task_id === 'active-task')).toBe(true);
    expect(status.index.active_tasks).toContain('active-task');
    expect(typeof status.active).toBe('boolean');
    expect(status.todo).toBeDefined();
  });

  it('pause and resume mutate ssot task status', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-pause-'));
    useTempAfkRoot(projectRoot);
    initTaskArtifacts({ taskId: 'pause-me', projectRoot, masterSessionId: null });

    pauseAfk('pause-me');
    expect(readSummary('pause-me')?.status).toBe('PAUSED');

    resumeAfk('pause-me');
    expect(readSummary('pause-me')?.status).toBe('READY');
  });

  it('setTaskHeartbeat persists automation id', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-heartbeat-'));
    useTempAfkRoot(projectRoot);
    initTaskArtifacts({ taskId: 'hb-task', projectRoot, masterSessionId: null });

    const summary = setTaskHeartbeat('hb-task', 'auto-123');
    expect(summary.heartbeat).toEqual({ automation_id: 'auto-123' });
  });

  it('readDecisionsReport returns excerpts from DECISIONS.md', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-report-'));
    const afkRoot = useTempAfkRoot(projectRoot);
    const { taskDir } = initTaskArtifacts({ taskId: 'report-task', projectRoot, masterSessionId: null });
    writeFileSync(join(taskDir, 'DECISIONS.md'), '# Decisions\n\n- chose sqlite for local cache\n', 'utf8');

    const items = readDecisionsReport();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ taskId: 'report-task', lineCount: 1 });
    expect(items[0]!.excerpt).toContain('sqlite');
    expect(readAfkSummaryList().summaries.some((item) => item.task_id === 'report-task')).toBe(true);
    expect(existsSync(join(afkRoot, 'tasks', 'report-task', 'DECISIONS.md'))).toBe(true);
  });

  it('buildInitialInjectPrompt includes state machine and reply format', () => {
    const prompt = buildInitialInjectPrompt({
      taskId: 'demo',
      projectRoot: '/tmp/demo',
      summary: {
        task_id: 'demo',
        status: 'PLANNING',
        master_session_id: null,
        current_unit: null,
        plan_revision: 0,
        loop: 0,
        allowlist: ['src/a.ts'],
        permission_request: null,
        last_command: null,
        last_verification: null,
        human_action_hint: null,
        updated_at: new Date().toISOString(),
      },
      nextTodo: 'U1 — first unit',
      criteria: ['npm test'],
    });
    expect(prompt).toContain('状态机');
    expect(prompt).toContain('DECISIONS');
    expect(prompt).toContain('reply 格式');
    expect(prompt).toContain('src/a.ts');
  });

  it('normalizeAfkMode defaults to solo when omitted', () => {
    expect(normalizeAfkMode()).toBe('solo');
    expect(normalizeAfkMode('')).toBe('solo');
    expect(normalizeAfkMode('  ')).toBe('solo');
    expect(normalizeAfkMode('go')).toBe('go');
    expect(normalizeAfkMode('START')).toBe('start');
    expect(() => normalizeAfkMode('invalid')).toThrow('invalid_afk_mode:invalid');
  });

  it('oneClickAfk mode=go sets task allow_new_subagents=false without global patch', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-go-mode-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-go-store-')));
    roots.push(store.root);

    const patchSpy = vi.spyOn(orchestratorConfig, 'patchGlobalConfig').mockImplementation((() => ({
      ...orchestratorConfig.loadConfig(),
    })) as typeof orchestratorConfig.patchGlobalConfig);

    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const existing = store.register({ name: 'Go Master' }).session;
    const result = await oneClickAfk(store, {
      taskSlug: 'go-task',
      projectRoot,
      sessionId: existing.sessionId,
      mode: 'go',
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });

    expect(result.sessionId).toBe(existing.sessionId);
    const subagentPatches = patchSpy.mock.calls.filter(
      ([patch]) => 'allowNewSubagents' in patch || 'autoDispatchSubagents' in patch,
    );
    expect(subagentPatches).toHaveLength(0);

    const summary = readSummary('go-task');
    expect(summary?.mode).toBe('go');
    expect(summary?.allow_new_subagents).toBe(false);

    const history = store.getHistory(existing.sessionId);
    const inject = history.find((msg) => msg.content.includes('【Rr AFK · 首条注入】'));
    expect(inject?.content).toContain('Mode=go');
    expect(inject?.content).toContain('禁止 list_subagents / dispatch_subagent_task');
    expect(inject?.content).toContain('KEEPALIVE');
    expect(inject?.content).toContain('原 sessionId');
  });

  it('oneClickAfk mode=solo does not force allowNewSubagents OFF', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-solo-mode-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-solo-store-')));
    roots.push(store.root);

    const patchSpy = vi.spyOn(orchestratorConfig, 'patchGlobalConfig').mockImplementation((() => ({
      ...orchestratorConfig.loadConfig(),
    })) as typeof orchestratorConfig.patchGlobalConfig);

    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const existing = store.register({ name: 'Solo Master' }).session;
    await oneClickAfk(store, {
      taskSlug: 'solo-task',
      projectRoot,
      sessionId: existing.sessionId,
      mode: 'solo',
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });

    const subagentPatches = patchSpy.mock.calls.filter(
      ([patch]) => 'allowNewSubagents' in patch || 'autoDispatchSubagents' in patch,
    );
    expect(subagentPatches).toHaveLength(0);

    const summary = readSummary('solo-task');
    expect(summary?.mode).toBe('solo');

    const history = store.getHistory(existing.sessionId);
    const inject = history.find((msg) => msg.content.includes('【Rr AFK · 首条注入】'));
    expect(inject?.content).toContain('Mode=solo');
    expect(inject?.content).toContain('never-ask');
  });

  it('oneClickAfk mode=start does not force allowNewSubagents OFF', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-start-mode-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-start-store-')));
    roots.push(store.root);

    const patchSpy = vi.spyOn(orchestratorConfig, 'patchGlobalConfig').mockImplementation((() => ({
      ...orchestratorConfig.loadConfig(),
    })) as typeof orchestratorConfig.patchGlobalConfig);

    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });

    const existing = store.register({ name: 'Start Master' }).session;
    await oneClickAfk(store, {
      taskSlug: 'start-task',
      projectRoot,
      sessionId: existing.sessionId,
      mode: 'start',
      startOrchestrator: false,
    }, { spawnEnqueue: vi.fn() });

    const subagentPatches = patchSpy.mock.calls.filter(
      ([patch]) => 'allowNewSubagents' in patch || 'autoDispatchSubagents' in patch,
    );
    expect(subagentPatches).toHaveLength(0);

    const summary = readSummary('start-task');
    expect(summary?.mode).toBe('start');

    const history = store.getHistory(existing.sessionId);
    const inject = history.find((msg) => msg.content.includes('【Rr AFK · 首条注入】'));
    expect(inject?.content).toContain('Mode=start');
  });

  it('oneClickAfk does not patch go config when master session is missing', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-go-fail-'));
    useTempAfkRoot(projectRoot);
    const store = new RrFileStore(mkdtempSync(join(tmpdir(), 'rr-afk-go-fail-store-')));
    roots.push(store.root);

    const patchSpy = vi.spyOn(orchestratorConfig, 'patchGlobalConfig').mockImplementation((() => ({
      ...orchestratorConfig.loadConfig(),
    })) as typeof orchestratorConfig.patchGlobalConfig);

    await expect(oneClickAfk(store, {
      taskSlug: 'go-fail',
      projectRoot,
      mode: 'go',
      spawnIfNeeded: false,
      startOrchestrator: false,
    })).rejects.toThrow('no_master_session');

    const subagentPatches = patchSpy.mock.calls.filter(
      ([patch]) => 'allowNewSubagents' in patch || 'autoDispatchSubagents' in patch,
    );
    expect(subagentPatches).toHaveLength(0);
  });
});
