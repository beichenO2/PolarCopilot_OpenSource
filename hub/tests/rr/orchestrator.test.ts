import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCriteriaSummary, parseTodoItems, readAfkSnapshot } from '../../src/rr/orchestrator/afk-state.js';
import { loadConfig } from '../../src/rr/orchestrator/config.js';
import { planNextAction } from '../../src/rr/orchestrator/planner.js';
import { defaultState } from '../../src/rr/orchestrator/state.js';
import { RrFileStore } from '../../src/rr/store.js';
import type { OrchestratorConfig } from '../../src/rr/orchestrator/types.js';

describe('rr orchestrator planner', () => {
  const envBackup = { ...process.env };
  const roots: string[] = [];
  afterEach(() => {
    process.env = { ...envBackup };
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function setupRoot(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    const rrAfkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-isolated-'));
    roots.push(rrAfkRoot);
    process.env.RR_AFK_ROOT = rrAfkRoot;
    process.env.RR_AFK_LEGACY_ROOT = join(root, 'afk');
    return root;
  }

  function baseConfig(root: string, projectRoot: string): OrchestratorConfig {
    return {
      hubUrl: 'http://127.0.0.1:8040',
      projectRoot,
      masterSessionId: null,
      masterSessionName: null,
      afkRoot: join(root, 'afk'),
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
      statePath: join(root, 'state.json'),
      logPath: join(root, 'events.jsonl'),
    };
  }

  it('returns noop when AFK is not armed', () => {
    const root = setupRoot('rr-orch-');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    store.updateSession(main.sessionId, { agentStatus: 'ready' });
    const action = planNextAction({
      config: baseConfig(root, root),
      state: defaultState(),
      afk: readAfkSnapshot(baseConfig(root, root)),
      session: { ...main, waiting: true, status: 'waiting', lastActiveAt: Date.now() - 5_000 },
      history: [],
      subagents: [],
    });
    expect(action.kind).toBe('noop');
  });

  it('injects next todo when AFK active and master is waiting idle', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] 修复登录偶发 500\n- [ ] 补测试\n', 'utf8');
    writeFileSync(join(root, 'CRITERIA.md'), '- npm test 全绿\n', 'utf8');

    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
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
      subagents: [],
    }, Date.now());
    expect(action.kind).toBe('inject');
    if (action.kind === 'inject') {
      expect(action.content).toContain('修复登录偶发 500');
      expect(action.content).toContain('npm test 全绿');
    }
  });

  it('dispatches research todo to idle subagent when enabled', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] 调研 rr 路由性能\n- [ ] 实现修复\n', 'utf8');

    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const child = store.register({ name: 'Child' }).session;
    store.setSubagent(child.sessionId, true);
    const config = baseConfig(root, root);

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
    expect(action.kind).toBe('dispatch');
    if (action.kind === 'dispatch') {
      expect(action.targetSessionId).toBe(child.sessionId);
      expect(action.content).toContain('调研 rr 路由性能');
    }
  });

  it('parses todo and criteria helpers', () => {
    expect(parseTodoItems('- [ ] one\n- [x] done\n')).toEqual(['one']);
    expect(parseCriteriaSummary('- test green\n')).toEqual(['- test green']);
  });

  it('loads merged config paths', () => {
    const root = setupRoot('rr-orch-');
    writeFileSync(join(root, '.rr-orchestrator.json'), JSON.stringify({ idleInjectDelayMs: 777 }), 'utf8');
    const config = loadConfig(root);
    expect(config.idleInjectDelayMs).toBe(777);
    expect(config.projectRoot).toBe(root);
  });

  it('does not wake when inbox already has pending messages (offline flood guard)', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] keep going\n', 'utf8');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
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
        pendingMessages: 12,
        agentStatus: 'ready',
      },
      history: [],
      subagents: [],
    }, now);
    expect(action.kind).toBe('noop');
    if (action.kind === 'noop') expect(action.reason).toMatch(/inbox/);
  });

  it('does not inject while agent is developing even if status is online', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] keep going\n', 'utf8');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
    const now = Date.now();
    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: {
        ...main,
        waiting: false,
        status: 'online',
        online: true,
        lastActiveAt: now - 60_000,
        pendingMessages: 0,
        agentStatus: 'developing',
      },
      history: [],
      subagents: [],
    }, now);
    expect(action.kind).toBe('noop');
    if (action.kind === 'noop') expect(action.reason).toMatch(/忙碌/);
  });

  it('does not inject when online but not waiting', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] keep going\n', 'utf8');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
    const now = Date.now();
    const action = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session: {
        ...main,
        waiting: false,
        status: 'online',
        online: true,
        lastActiveAt: now - 60_000,
        pendingMessages: 0,
        agentStatus: 'ready',
      },
      history: [],
      subagents: [],
    }, now);
    expect(action.kind).toBe('noop');
    if (action.kind === 'noop') expect(action.reason).toMatch(/wait_message/);
  });

  it('cools down repeated offline wakes', () => {
    const root = setupRoot('rr-orch-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] keep going\n', 'utf8');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
    const now = Date.now();
    const session = {
      ...main,
      waiting: false,
      status: 'offline' as const,
      online: false,
      lastActiveAt: now - 60_000,
      pendingMessages: 0,
      agentStatus: 'ready',
    };
    const first = planNextAction({
      config,
      state: defaultState(),
      afk: readAfkSnapshot(config),
      session,
      history: [],
      subagents: [],
    }, now);
    expect(first.kind).toBe('wake');
    const second = planNextAction({
      config,
      state: {
        ...defaultState(),
        lastInjectedAt: now,
        lastInjectedHash: 'anything',
        lastAction: 'wake',
      },
      afk: readAfkSnapshot(config),
      session,
      history: [],
      subagents: [],
    }, now + 100);
    expect(second.kind).toBe('noop');
  });

  it('wakes an offline developing master instead of treating stale status as busy', () => {
    const root = setupRoot('rr-orch-offline-developing-');
    mkdirSync(join(root, 'afk'), { recursive: true });
    writeFileSync(join(root, 'afk', 'ACTIVE'), '', 'utf8');
    writeFileSync(join(root, 'TODO.md'), '- [ ] resume work\n', 'utf8');
    const store = new RrFileStore(join(root, 'chat'));
    const main = store.register({ name: 'Main' }).session;
    const config = baseConfig(root, root);
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
        agentStatus: 'developing',
      },
      history: [],
      subagents: [],
    }, now);
    expect(action.kind).toBe('wake');
  });

  it('toggle flag gates enabled state', () => {
    const root = setupRoot('rr-orch-toggle-');
    const flag = join(root, 'enabled');
    writeFileSync(flag, '1\n', 'utf8');
    expect(existsSync(flag)).toBe(true);
    rmSync(flag);
    expect(existsSync(flag)).toBe(false);
  });
});
