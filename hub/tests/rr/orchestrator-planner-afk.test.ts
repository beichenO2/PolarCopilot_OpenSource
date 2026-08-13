import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initTaskArtifacts,
  writeState,
  writeSummary,
} from '../../src/rr/afk/index.js';
import { readAfkSnapshot } from '../../src/rr/orchestrator/afk-state.js';
import { planNextAction } from '../../src/rr/orchestrator/planner.js';
import { defaultState } from '../../src/rr/orchestrator/state.js';
import { RrFileStore } from '../../src/rr/store.js';
import type { OrchestratorConfig } from '../../src/rr/orchestrator/types.js';

describe('rr orchestrator planner + rr-afk snapshot', () => {
  const envBackup = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function useTempRoots(): { workspace: string; rrAfkRoot: string; legacyAfkRoot: string } {
    const workspace = mkdtempSync(join(tmpdir(), 'rr-orch-afk-'));
    const rrAfkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-new-'));
    const legacyAfkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-legacy-'));
    roots.push(workspace, rrAfkRoot, legacyAfkRoot);
    process.env.RR_AFK_ROOT = rrAfkRoot;
    process.env.RR_AFK_LEGACY_ROOT = legacyAfkRoot;
    return { workspace, rrAfkRoot, legacyAfkRoot };
  }

  function baseConfig(workspace: string, legacyAfkRoot: string): OrchestratorConfig {
    return {
      hubUrl: 'http://127.0.0.1:8040',
      projectRoot: workspace,
      masterSessionId: null,
      masterSessionName: null,
      afkRoot: legacyAfkRoot,
      pollIntervalMs: 5_000,
      idleInjectDelayMs: 1_000,
      offlineWakeDelayMs: 2_000,
      maxInjectionsPerHour: 120,
      maxLoops: 40,
      autoDispatchSubagents: true,
      loopBridge: false,
      loopSentinelPrefix: 'RR_ORCH_TICK',
      todoPaths: ['TODO.md'],
      criteriaPaths: ['CRITERIA.md'],
      verifyCommands: [],
      injectPrefix: '【测试】',
      statePath: join(workspace, 'state.json'),
      logPath: join(workspace, 'events.jsonl'),
    };
  }

  function waitingSession(store: RrFileStore) {
    const main = store.register({ name: 'Main' }).session;
    return {
      ...main,
      waiting: true,
      status: 'waiting' as const,
      online: true,
      lastActiveAt: Date.now() - 5_000,
      pendingMessages: 0,
    };
  }

  it('readAfkSnapshot prefers ~/.rr-cursor/afk summaries over legacy ACTIVE', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();

    initTaskArtifacts({
      taskId: 'rr-primary',
      projectRoot: workspace,
      masterSessionId: 'sess-1',
      tasks: '- [ ] rr unit one\n',
      criteria: '- npm test green\n',
      maxLoops: 15,
    });
    writeState('rr-primary', {
      task_id: 'rr-primary',
      status: 'RUNNING',
      master_session_id: 'sess-1',
      project_root: workspace,
      current_unit: 'U1 — fix login 500',
      plan_revision: 2,
      loop: 3,
      max_loops: 15,
      allowlist: ['hub/src/rr/router.ts'],
      permission_request: null,
      last_command: 'npm test',
      last_verification: { ok: true, summary: '42 passed' },
      human_action_hint: null,
      updated_at: new Date().toISOString(),
    });

    // Legacy flags written after RR store exists — snapshot must still prefer RR summaries.
    writeFileSync(join(legacyAfkRoot, 'ACTIVE'), '', 'utf8');
    writeFileSync(join(workspace, 'TODO.md'), '- [ ] legacy todo\n', 'utf8');

    const config = baseConfig(workspace, legacyAfkRoot);
    const snapshot = readAfkSnapshot(config);

    expect(snapshot.source).toBe('rr-afk');
    expect(snapshot.taskId).toBe('rr-primary');
    expect(snapshot.active).toBe(true);
    expect(snapshot.primarySummary).toMatchObject({
      status: 'RUNNING',
      current_unit: 'U1 — fix login 500',
      plan_revision: 2,
      allowlist: ['hub/src/rr/router.ts'],
    });
    expect(snapshot.todoText).toContain('rr unit one');
    expect(snapshot.maxLoops).toBe(15);
  });

  it('falls back to legacy ~/.cursor/afk when rr store is empty', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    mkdirSync(join(legacyAfkRoot, 'task-a'), { recursive: true });
    writeFileSync(join(legacyAfkRoot, 'ACTIVE'), '', 'utf8');
    writeFileSync(join(legacyAfkRoot, 'task-a', 'TODO.md'), '- [ ] legacy item\n', 'utf8');
    writeFileSync(join(legacyAfkRoot, 'MAX_LOOPS'), '22\n', 'utf8');

    const config = baseConfig(workspace, legacyAfkRoot);
    const snapshot = readAfkSnapshot(config);

    expect(snapshot.source).toBe('legacy');
    expect(snapshot.active).toBe(true);
    expect(snapshot.todoText).toContain('legacy item');
    expect(snapshot.maxLoops).toBe(22);
  });

  it('inject prompt includes summary fields and DECISIONS/reply contract', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'inject-task',
      projectRoot: workspace,
      masterSessionId: 'sess-2',
      tasks: '- [ ] implement feature\n',
      criteria: '- build passes\n',
    });
    writeState('inject-task', {
      task_id: 'inject-task',
      status: 'RUNNING',
      master_session_id: 'sess-2',
      project_root: workspace,
      current_unit: 'U2 — add endpoint',
      plan_revision: 1,
      loop: 1,
      max_loops: 40,
      allowlist: ['hub/src/rr/orchestrator/planner.ts'],
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U2',
        plan_revision: 1,
        paths: ['hub/tests/rr/orchestrator-planner-afk.test.ts'],
      },
      last_command: 'npx vitest run',
      last_verification: { ok: true },
      human_action_hint: 'Review allowlist before merge',
      updated_at: new Date().toISOString(),
    });

    const config = baseConfig(workspace, legacyAfkRoot);
    const store = new RrFileStore(join(workspace, 'chat'));
    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: waitingSession(store),
      history: [],
      subagents: [],
    }, Date.now());

    expect(action.kind).toBe('inject');
    if (action.kind !== 'inject') return;

    expect(action.content).toContain('status: RUNNING');
    expect(action.content).toContain('current_unit: U2 — add endpoint');
    expect(action.content).toContain('plan_revision: 1');
    expect(action.content).toContain('hub/src/rr/orchestrator/planner.ts');
    expect(action.content).toContain('permission_request');
    expect(action.content).toContain('hub/tests/rr/orchestrator-planner-afk.test.ts');
    expect(action.content).toContain('human_action_hint');
    expect(action.content).toContain('Review allowlist before merge');
    expect(action.content).toContain('DECISIONS.md');
    expect(action.content).toContain('status / 命令 / 验证');
    expect(action.content).toContain('U2 — add endpoint');
  });

  it('NEEDS_HUMAN inject tells agent to wait for grant instead of advancing', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'needs-human',
      projectRoot: workspace,
      masterSessionId: 'sess-3',
      tasks: '- [ ] blocked unit\n',
    });
    writeState('needs-human', {
      task_id: 'needs-human',
      status: 'NEEDS_HUMAN',
      master_session_id: 'sess-3',
      project_root: workspace,
      current_unit: 'U3 — deploy staging',
      plan_revision: 4,
      loop: 2,
      max_loops: 40,
      allowlist: [],
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U3',
        plan_revision: 4,
        paths: ['infra/staging.env'],
      },
      last_command: null,
      last_verification: null,
      human_action_hint: 'Grant write to infra/staging.env in panel',
      updated_at: new Date().toISOString(),
    });

    const config = baseConfig(workspace, legacyAfkRoot);
    const store = new RrFileStore(join(workspace, 'chat'));
    const afk = readAfkSnapshot(config);
    const action = planNextAction({
      config,
      state: defaultState(),
      afk,
      session: waitingSession(store),
      history: [],
      subagents: [],
    }, Date.now());

    expect(afk.primarySummary?.status).toBe('NEEDS_HUMAN');
    expect(action.kind).toBe('inject');
    if (action.kind !== 'inject') return;

    expect(action.reason).toMatch(/NEEDS_HUMAN/);
    expect(action.content).toContain('status: NEEDS_HUMAN');
    expect(action.content).toContain('等待人工授权');
    expect(action.content).toContain('禁止空转推进');
    expect(action.content).toContain('Grant write to infra/staging.env');
    expect(action.content).not.toContain('本轮首选原子任务');
  });

  it('inject prompt for mode=go forbids dispatch even when config allows subagents', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'go-inject-task',
      projectRoot: workspace,
      masterSessionId: 'sess-go',
      tasks: '- [ ] implement feature\n',
      mode: 'go',
    });
    writeState('go-inject-task', {
      task_id: 'go-inject-task',
      status: 'RUNNING',
      master_session_id: 'sess-go',
      project_root: workspace,
      current_unit: 'U1 — solo work',
      plan_revision: 0,
      loop: 0,
      max_loops: 40,
      allowlist: [],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: null,
      updated_at: new Date().toISOString(),
      mode: 'go',
    });

    const config = {
      ...baseConfig(workspace, legacyAfkRoot),
      allowNewSubagents: true,
      autoDispatchSubagents: true,
    };
    const store = new RrFileStore(join(workspace, 'chat-go'));
    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: waitingSession(store),
      history: [],
      subagents: [],
    }, Date.now());

    expect(action.kind).toBe('inject');
    if (action.kind !== 'inject') return;

    expect(action.content).toContain('mode: go');
    expect(action.content).toContain('禁止 list_subagents / dispatch_subagent_task');
    expect(action.content).not.toContain('可 dispatch_subagent_task');
  });

  it('mode=go skips auto-dispatch even with research TODO + idle subagent + config ON', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'go-no-dispatch',
      projectRoot: workspace,
      masterSessionId: 'sess-go-disp',
      tasks: '- [ ] 调研 rr 路由性能\n',
      mode: 'go',
    });
    writeFileSync(join(process.env.RR_AFK_ROOT!, 'tasks', 'go-no-dispatch', 'TODO.md'), '# TODO\n\n- [ ] 调研 rr 路由性能\n', 'utf8');
    writeState('go-no-dispatch', {
      task_id: 'go-no-dispatch',
      status: 'RUNNING',
      master_session_id: 'sess-go-disp',
      project_root: workspace,
      current_unit: '调研 rr 路由性能',
      plan_revision: 0,
      loop: 0,
      max_loops: 40,
      allowlist: [],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: null,
      updated_at: new Date().toISOString(),
      mode: 'go',
    });

    const config = {
      ...baseConfig(workspace, legacyAfkRoot),
      allowNewSubagents: true,
      autoDispatchSubagents: true,
    };
    const store = new RrFileStore(join(workspace, 'chat-go-disp'));
    const main = store.register({ name: 'Go Main' }).session;
    const child = store.register({ name: 'Go Child' }).session;
    store.setSubagent(child.sessionId, true);

    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: {
        ...main,
        waiting: true,
        status: 'waiting',
        online: true,
        lastActiveAt: Date.now() - 5_000,
        pendingMessages: 0,
      },
      history: [],
      subagents: [{
        sessionId: child.sessionId,
        name: child.name,
        availability: 'idle',
        agentStatus: 'ready',
        lastActiveAt: Date.now(),
      }],
    }, Date.now());

    expect(action.kind).not.toBe('dispatch');
    expect(action.kind).toBe('inject');
  });

  it('wake prompt includes summary context for offline recovery', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'wake-task',
      projectRoot: workspace,
      masterSessionId: 'sess-4',
    });
    writeSummary('wake-task', {
      task_id: 'wake-task',
      status: 'READY',
      master_session_id: 'sess-4',
      current_unit: 'U1 — resume tests',
      plan_revision: 0,
      loop: 0,
      allowlist: ['hub/'],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: null,
      updated_at: new Date().toISOString(),
      project_root: workspace,
    });

    const config = baseConfig(workspace, legacyAfkRoot);
    const store = new RrFileStore(join(workspace, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const now = Date.now();
    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: {
        ...main,
        waiting: false,
        status: 'offline',
        online: false,
        lastActiveAt: now - 60_000,
        pendingMessages: 0,
        agentStatus: 'ready',
      },
      history: [],
      subagents: [],
    }, now);

    expect(action.kind).toBe('wake');
    if (action.kind !== 'wake') return;

    expect(action.content).toContain('status: READY');
    expect(action.content).toContain('current_unit: U1 — resume tests');
    expect(action.content).toContain('DECISIONS.md');
    expect(action.content).toContain('续跑单元');
    expect(action.content).toContain('U1 — resume tests');
  });

  it('does not dispatch subagents while NEEDS_HUMAN', () => {
    const { workspace, legacyAfkRoot } = useTempRoots();
    initTaskArtifacts({
      taskId: 'needs-human-dispatch',
      projectRoot: workspace,
      masterSessionId: 'sess-5',
      tasks: '- [ ] 调研 rr 路由性能\n',
    });
    writeState('needs-human-dispatch', {
      task_id: 'needs-human-dispatch',
      status: 'NEEDS_HUMAN',
      master_session_id: 'sess-5',
      project_root: workspace,
      current_unit: '调研 rr 路由性能',
      plan_revision: 1,
      loop: 1,
      max_loops: 40,
      allowlist: [],
      permission_request: null,
      last_command: null,
      last_verification: null,
      human_action_hint: 'Approve research scope',
      updated_at: new Date().toISOString(),
    });

    const config = baseConfig(workspace, legacyAfkRoot);
    const store = new RrFileStore(join(workspace, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const child = store.register({ name: 'Child' }).session;
    store.setSubagent(child.sessionId, true);

    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: {
        ...main,
        waiting: true,
        status: 'waiting',
        online: true,
        lastActiveAt: Date.now() - 5_000,
        pendingMessages: 0,
      },
      history: [],
      subagents: [{
        sessionId: child.sessionId,
        name: child.name,
        availability: 'idle',
        agentStatus: 'ready',
        lastActiveAt: Date.now(),
      }],
    }, Date.now());

    expect(action.kind).toBe('inject');
    if (action.kind === 'inject') {
      expect(action.reason).toMatch(/NEEDS_HUMAN/);
    }
  });
});
