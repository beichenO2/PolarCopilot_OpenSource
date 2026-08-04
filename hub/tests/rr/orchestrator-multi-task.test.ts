import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initTaskArtifacts, readIndex, writeState } from '../../src/rr/afk/index.js';
import { readOrchestratorHealth } from '../../src/rr/orchestrator/health.js';
import {
  bumpTaskInjection,
  defaultState,
  getTaskOrchestratorState,
  plannerStateForTask,
  saveState,
} from '../../src/rr/orchestrator/state.js';
import { readActiveTaskSnapshots, readTaskAfkSnapshot } from '../../src/rr/orchestrator/afk-state.js';
import {
  resolveInjectFanOutCap,
  RrOrchestratorRunner,
  sortFanOutCandidates,
} from '../../src/rr/orchestrator/runner.js';
import { setOrchestratorEnabled } from '../../src/rr/orchestrator/toggle.js';
import * as polarBudget from '../../src/rr/polar-budget.js';
import type { OrchestratorConfig } from '../../src/rr/orchestrator/types.js';
import type { RrSession } from '../../src/rr/types.js';

describe('orchestrator multi-task AFK', () => {
  const roots: string[] = [];
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setOrchestratorEnabled(false);
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function setup(projectRoot: string): OrchestratorConfig {
    const afkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-multi-'));
    roots.push(projectRoot, afkRoot);
    process.env.RR_AFK_ROOT = afkRoot;
    return {
      hubUrl: 'http://127.0.0.1:8040',
      projectRoot,
      masterSessionId: null,
      masterSessionName: null,
      afkRoot: join(projectRoot, 'legacy-afk'),
      pollIntervalMs: 5_000,
      idleInjectDelayMs: 1_000,
      offlineWakeDelayMs: 2_000,
      maxInjectionsPerHour: 120,
      maxLoops: 40,
      autoDispatchSubagents: false,
      loopBridge: false,
      loopSentinelPrefix: 'RR_ORCH_TICK',
      todoPaths: ['TODO.md'],
      criteriaPaths: ['CRITERIA.md'],
      verifyCommands: [],
      injectPrefix: '【测试】',
      statePath: join(projectRoot, 'state.json'),
      logPath: join(projectRoot, 'events.jsonl'),
      budgetShedder: false,
      maintainSubagentPool: false,
    };
  }

  function waitingSession(sessionId: string, name: string): RrSession {
    return {
      sessionId,
      name,
      waiting: true,
      status: 'waiting',
      online: true,
      lastActiveAt: Date.now() - 10_000,
      pendingMessages: 0,
      isSubagent: false,
      agentStatus: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: name,
      role: 'general-purpose',
      workspace: '/tmp',
    } as RrSession;
  }

  it('readActiveTaskSnapshots returns one snapshot per active task', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-multi-proj-'));
    const config = setup(projectRoot);

    initTaskArtifacts({
      taskId: 'task-x',
      projectRoot,
      masterSessionId: 'master-x',
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'task-y',
      projectRoot,
      masterSessionId: 'master-y',
      activate: true,
    });

    const snapshots = readActiveTaskSnapshots(config);
    expect(snapshots.map((item) => item.taskId).sort()).toEqual(['task-x', 'task-y']);
    expect(readTaskAfkSnapshot(config, 'task-x')?.primarySummary?.master_session_id).toBe('master-x');
    expect(readTaskAfkSnapshot(config, 'task-y')?.primarySummary?.master_session_id).toBe('master-y');
    expect(readIndex().active_tasks.sort()).toEqual(['task-x', 'task-y']);
  });

  it('bumpTaskInjection isolates cooldown per taskId', () => {
    const now = Date.now();
    let state = defaultState();
    state = bumpTaskInjection(state, 'task-a', now, 120, 'sess-a', 'inject', 'hash-a');
    state = bumpTaskInjection(state, 'task-b', now + 1, 120, 'sess-b', 'inject', 'hash-b');

    const taskA = getTaskOrchestratorState(state, 'task-a');
    const taskB = getTaskOrchestratorState(state, 'task-b');
    expect(taskA.loopCount).toBe(1);
    expect(taskB.loopCount).toBe(1);
    expect(taskA.lastSessionId).toBe('sess-a');
    expect(taskB.lastSessionId).toBe('sess-b');
    expect(taskA.lastInjectedHash).toBe('hash-a');
    expect(taskB.lastInjectedHash).toBe('hash-b');

    const plannerA = plannerStateForTask(state, 'task-a');
    const plannerB = plannerStateForTask(state, 'task-b');
    expect(plannerA.loopCount).toBe(1);
    expect(plannerB.loopCount).toBe(1);
    expect(plannerA.lastInjectedAt).not.toBe(plannerB.lastInjectedAt);
  });

  it('resolveInjectFanOutCap follows recommended_jobs (not admission floor)', () => {
    expect(resolveInjectFanOutCap(4)).toBe(4);
    expect(resolveInjectFanOutCap(14)).toBe(14);
    expect(resolveInjectFanOutCap(0)).toBe(1);
    expect(resolveInjectFanOutCap(undefined)).toBe(1);
    expect(resolveInjectFanOutCap(Number.NaN)).toBe(1);
    expect(resolveInjectFanOutCap({ ok: true, recommended_jobs: 8, reason: 'warm' })).toBe(8);
    expect(resolveInjectFanOutCap({ ok: true, recommended_jobs: 3, reason: 'warm' })).toBe(3);
  });

  it('maps afk_budget_capacity to HTTP 409', async () => {
    const { errorStatus } = await import('../../src/rr/router.js');
    expect(errorStatus(new Error('afk_budget_capacity'))).toBe(409);
  });

  it('sortFanOutCandidates prefers oldest lastInjectedAt', () => {
    const ordered = sortFanOutCandidates([
      { taskId: 'task-new', lastInjectedAt: Date.now() },
      { taskId: 'task-old', lastInjectedAt: Date.now() - 60_000 },
      { taskId: 'task-never', lastInjectedAt: null },
    ]);
    expect(ordered.map((item) => item.taskId)).toEqual(['task-never', 'task-old', 'task-new']);
  });

  it('readOrchestratorHealth stays ok when one sibling is paused', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-multi-health-'));
    const config = setup(projectRoot);

    initTaskArtifacts({
      taskId: 'task-active',
      projectRoot,
      masterSessionId: 'master-active',
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'task-paused',
      projectRoot,
      masterSessionId: 'master-paused',
      activate: true,
    });
    writeState('task-paused', {
      task_id: 'task-paused',
      status: 'PAUSED',
      master_session_id: 'master-paused',
      project_root: projectRoot,
      current_unit: null,
      plan_revision: 0,
      loop: 0,
      max_loops: 40,
      allowlist: [],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: null,
      updated_at: new Date().toISOString(),
    });

    setOrchestratorEnabled(true);
    saveState(config.statePath, defaultState());

    const health = readOrchestratorHealth(projectRoot);
    expect(health.ok).toBe(true);
    expect(health.eligibleActiveTaskCount).toBe(1);
    expect(health.paused).toBe(false);
  });

  it('tickOnce injects up to recommended_jobs tasks per tick (fair rotate)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-multi-cap-'));
    const config = setup(projectRoot);
    setOrchestratorEnabled(true);

    initTaskArtifacts({
      taskId: 'task-a',
      projectRoot,
      masterSessionId: 'master-a',
      tasks: '- [ ] unit a\n',
      criteria: '- test a\n',
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'task-b',
      projectRoot,
      masterSessionId: 'master-b',
      tasks: '- [ ] unit b\n',
      criteria: '- test b\n',
      activate: true,
    });
    initTaskArtifacts({
      taskId: 'task-c',
      projectRoot,
      masterSessionId: 'master-c',
      tasks: '- [ ] unit c\n',
      criteria: '- test c\n',
      activate: true,
    });

    for (const [taskId, sessionId] of [
      ['task-a', 'master-a'],
      ['task-b', 'master-b'],
      ['task-c', 'master-c'],
    ] as const) {
      writeState(taskId, {
        task_id: taskId,
        status: 'RUNNING',
        master_session_id: sessionId,
        project_root: projectRoot,
        current_unit: `U — ${taskId}`,
        plan_revision: 1,
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

    const now = Date.now();
    let state = defaultState();
    state = bumpTaskInjection(state, 'task-a', now - 120_000, 120, 'master-a', 'inject', 'hash-a');
    state = bumpTaskInjection(state, 'task-b', now - 60_000, 120, 'master-b', 'inject', 'hash-b');
    saveState(config.statePath, state);

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 2,
      reason: 'test',
    });

    const injectCalls: string[] = [];
    const sessions = [
      waitingSession('master-a', 'Main A'),
      waitingSession('master-b', 'Main B'),
      waitingSession('master-c', 'Main C'),
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (url.endsWith('/api/ui/rr/sessions') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ sessions }), { status: 200 });
      }
      if (url.includes('/api/ui/rr/subagents')) {
        return new Response(JSON.stringify({ subagents: [] }), { status: 200 });
      }
      const detailMatch = url.match(/\/api\/ui\/rr\/sessions\/([^/]+)$/);
      if (detailMatch && init?.method !== 'POST' && init?.method !== 'PATCH' && init?.method !== 'DELETE') {
        const sessionId = decodeURIComponent(detailMatch[1]!);
        const session = sessions.find((item) => item.sessionId === sessionId) ?? sessions[0]!;
        return new Response(JSON.stringify({ session, history: [] }), { status: 200 });
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { content: string };
        injectCalls.push(body.content);
        return new Response(JSON.stringify({ message: { role: 'user', content: body.content } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runner = new RrOrchestratorRunner(config);
    const tick = await runner.tickOnce();

    expect(injectCalls).toHaveLength(2);
    expect(injectCalls.some((content) => content.includes('task-c'))).toBe(true);
    expect(injectCalls.some((content) => content.includes('task-a'))).toBe(true);
    expect(injectCalls.some((content) => content.includes('task-b'))).toBe(false);

    const events = readFileSync(config.logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { action: string; detail?: { reason?: string }; taskId?: string });
    expect(events.some((event) => event.detail?.reason?.includes('budget_fanout_cap'))).toBe(true);
    expect(tick?.action.kind).toBe('inject');
  });

  it('resolveInjectFanOutCap=3 with 10 actives selects 3 injects per tick', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-multi-fleet-inject-'));
    const config = setup(projectRoot);
    setOrchestratorEnabled(true);

    const taskIds = Array.from({ length: 10 }, (_, i) => `fleet-${i}`);
    for (const taskId of taskIds) {
      initTaskArtifacts({
        taskId,
        projectRoot,
        masterSessionId: `master-${taskId}`,
        tasks: `- [ ] unit ${taskId}\n`,
        criteria: `- test ${taskId}\n`,
        activate: true,
      });
      writeState(taskId, {
        task_id: taskId,
        status: 'RUNNING',
        master_session_id: `master-${taskId}`,
        project_root: projectRoot,
        current_unit: `U — ${taskId}`,
        plan_revision: 1,
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

    vi.spyOn(polarBudget, 'fetchPolarBudget').mockResolvedValue({
      ok: true,
      recommended_jobs: 3,
      reason: 'test',
    });

    const injectCalls: string[] = [];
    const sessions = taskIds.map((taskId) => waitingSession(`master-${taskId}`, `Main ${taskId}`));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      }
      if (url.endsWith('/api/ui/rr/sessions') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ sessions }), { status: 200 });
      }
      if (url.includes('/api/ui/rr/subagents')) {
        return new Response(JSON.stringify({ subagents: [] }), { status: 200 });
      }
      const detailMatch = url.match(/\/api\/ui\/rr\/sessions\/([^/]+)$/);
      if (detailMatch && init?.method !== 'POST' && init?.method !== 'PATCH' && init?.method !== 'DELETE') {
        const sessionId = decodeURIComponent(detailMatch[1]!);
        const session = sessions.find((item) => item.sessionId === sessionId) ?? sessions[0]!;
        return new Response(JSON.stringify({ session, history: [] }), { status: 200 });
      }
      if (url.includes('/messages') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { content: string };
        injectCalls.push(body.content);
        return new Response(JSON.stringify({ message: { role: 'user', content: body.content } }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const runner = new RrOrchestratorRunner(config);
    await runner.tickOnce();

    expect(injectCalls).toHaveLength(3);
    expect(resolveInjectFanOutCap({ ok: true, recommended_jobs: 3, reason: 'test' })).toBe(3);
  });
});
