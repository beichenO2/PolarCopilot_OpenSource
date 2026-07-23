import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { XjFileStore } from '../../src/xj/store.js';

describe('XjFileStore persistent session loop', () => {
  let root: string;
  let store: XjFileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'polarcop-xj-'));
    store = new XjFileStore(root, { staleAfterMs: 24 * 60 * 60 * 1000 });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('deduplicates registration by stable client key and restores the same session', () => {
    const first = store.register({ clientKey: 'cursor:workspace-a:composer-1', title: 'Composer 1' });
    const second = store.register({ clientKey: 'cursor:workspace-a:composer-1', title: 'Renamed' });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.title).toBe('Renamed');
    expect(store.listSessions()).toHaveLength(1);
  });

  it('matches original XJ launchId registration and reconnect contract', () => {
    const first = store.register({
      launchId: 'xjlaunch-1784831456675-2f32d105',
      name: '通用 Agent',
      role: 'general-purpose',
      modes: ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'],
    });
    const second = store.register({
      sessionId: first.session.id,
      launchId: 'xjlaunch-1784831456675-2f32d105',
      name: '通用 Agent',
    });

    expect(first.session.id).toMatch(/^xj-mcp-agent-/);
    expect(second.session.id).toBe(first.session.id);
    expect(second.deduplicated).toBe(true);
    expect(second.session.launchId).toBe('xjlaunch-1784831456675-2f32d105');
    expect(second.session.name).toBe('通用 Agent');
    expect(second.session.role).toBe('general-purpose');
    expect(second.session.modes).toEqual(['夜晚自动化挂机任务', 'AI 破甲（道德经Max）']);
  });

  it('creates and deduplicates one main session with exactly two linked subagents', () => {
    const first = store.ensureSessionFamily({
      launchId: 'xjlaunch-family-main',
      name: '通用 Agent',
      role: 'general-purpose',
      title: '通用任务',
      modes: ['夜晚自动化挂机任务'],
    }, 2);
    const second = store.ensureSessionFamily({
      launchId: 'xjlaunch-family-main',
      name: '通用 Agent',
      role: 'general-purpose',
      title: '通用任务',
      modes: ['夜晚自动化挂机任务'],
    }, 2);

    expect(first.session.agentSlot).toBe('main');
    expect(first.subagents).toHaveLength(2);
    expect(first.subagents.map((session) => session.agentSlot)).toEqual(['subagent-1', 'subagent-2']);
    expect(first.subagents.every((session) => session.parentSessionId === first.session.id)).toBe(true);
    expect(first.subagents.map((session) => session.id)).toEqual(second.subagents.map((session) => session.id));
    expect(store.listSubagents(first.session.id).map((session) => session.id))
      .toEqual(first.subagents.map((session) => session.id));
    expect(store.listSessions()).toHaveLength(3);

    store.removeSession(first.session.id);
    expect(store.listSessions()).toHaveLength(0);
  });

  it('merges a launchId mistakenly registered as legacy client_key into the canonical family', () => {
    const launchId = 'xjlaunch-legacy-alias';
    const canonical = store.register({ launchId, name: '通用 Agent' }).session;
    const legacy = store.register({ clientKey: launchId, title: '旧错误会话' }).session;
    store.enqueueUserMessage(legacy.id, '不能丢失的旧消息');
    store.reply(legacy.id, '不能丢失的旧回复');

    const family = store.ensureSessionFamily({
      launchId,
      name: '通用 Agent',
      role: 'general-purpose',
      title: '通用任务',
    }, 2);

    expect(family.session.id).toBe(canonical.id);
    expect(family.session.name).toBe('通用 Agent');
    expect(family.session.role).toBe('general-purpose');
    expect(store.getHistory(canonical.id).map((message) => message.content))
      .toEqual(expect.arrayContaining(['不能丢失的旧消息', '不能丢失的旧回复']));
    expect(() => store.getSession(legacy.id)).toThrow('session_not_found');
    expect(store.listSessions()).toHaveLength(3);
  });

  it('dispatches a main task to a linked subagent and relays its reply to the main inbox', async () => {
    const family = store.ensureSessionFamily({
      launchId: 'xjlaunch-dispatch-main',
      name: '通用 Agent',
      role: 'general-purpose',
      title: '协作任务',
    }, 2);
    const child = family.subagents[0]!;
    store.enqueueUserMessage(family.session.id, '用户主任务');
    const originalMainTask = await store.waitMessage(family.session.id, { timeoutMs: 100 });
    expect(originalMainTask.message?.content).toBe('用户主任务');
    const dispatched = store.dispatchSubagentTask(family.session.id, child.id, '检查 API 契约', '契约检查');

    const childWait = await store.waitMessage(child.id, { timeoutMs: 100 });
    expect(childWait.message?.content).toBe('检查 API 契约');
    expect(childWait.message?.metadata).toMatchObject({
      type: 'subagent_task',
      taskId: dispatched.id,
      parentSessionId: family.session.id,
    });

    store.reply(child.id, 'API 契约检查通过', { evidence: ['contract test'] });
    const mainWait = await store.waitMessage(family.session.id, { timeoutMs: 100 });
    expect(mainWait.message?.content).toContain('[XJ_MSG · AGENT_RESULT]');
    expect(mainWait.message?.content).toContain('API 契约检查通过');
    expect(mainWait.message?.metadata).toMatchObject({
      type: 'subagent_result',
      taskId: dispatched.id,
      subagentId: child.id,
    });
    expect(readdirSync(join(root, 'sessions', family.session.id, 'processing'))).toHaveLength(2);
    store.reply(family.session.id, '主任务与子检查均已完成');
    expect(readdirSync(join(root, 'sessions', family.session.id, 'processing'))).toHaveLength(0);

    const otherFamily = store.ensureSessionFamily({
      launchId: 'xjlaunch-dispatch-other',
      name: '通用 Agent',
    }, 2);
    expect(() => store.dispatchSubagentTask(family.session.id, otherFamily.subagents[0]!.id, '越权任务'))
      .toThrow('subagent_not_linked');
  });

  it('persists session, history and inbox as local files', () => {
    const { session } = store.register({ clientKey: 'client-a', title: 'A' });
    const queued = store.enqueueUserMessage(session.id, '继续实现 **XJ**');

    expect(existsSync(join(root, 'sessions', session.id, 'session.json'))).toBe(true);
    expect(existsSync(join(root, 'sessions', session.id, 'inbox', `${queued.id}.json`))).toBe(true);
    expect(store.getHistory(session.id).map((item) => item.content)).toContain('继续实现 **XJ**');
  });

  it('wait_message blocks until a queued message arrives then marks the session working', async () => {
    const { session } = store.register({ clientKey: 'client-b', title: 'B' });
    const wait = store.waitMessage(session.id, { timeoutMs: 2_000 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getSession(session.id).status).toBe('waiting');
    store.enqueueUserMessage(session.id, '下一轮');

    const result = await wait;
    expect(result.kind).toBe('message');
    expect(result.message?.content).toBe('下一轮');
    expect(store.getSession(session.id).status).toBe('working');
  });

  it('returns a timeout without ending the stable session', async () => {
    const { session } = store.register({ clientKey: 'client-c', title: 'C' });
    const result = await store.waitMessage(session.id, { timeoutMs: 10 });

    expect(result.kind).toBe('timeout');
    expect(store.getSession(session.id).status).toBe('online');
    expect(store.getSession(session.id).reconnectUntil).toBeTruthy();
  });

  it('reply and progress are persisted and retain the continue-wait contract', () => {
    const { session } = store.register({ clientKey: 'client-d', title: 'D' });
    store.reportProgress(session.id, { percent: 45, summary: 'tests green', todo: ['build'] });
    const reply = store.reply(session.id, '已完成第一轮');

    expect(reply.continueWith).toBe('wait_message');
    expect(store.getHistory(session.id).at(-1)?.content).toBe('已完成第一轮');
    const persisted = JSON.parse(readFileSync(join(root, 'sessions', session.id, 'progress.json'), 'utf-8'));
    expect(persisted.percent).toBe(45);
    expect(persisted.todo).toEqual(['build']);
  });

  it('acknowledges the claimed inbox message when reply is persisted', async () => {
    const { session } = store.register({ clientKey: 'ack-client', title: 'Ack' });
    store.enqueueUserMessage(session.id, '待确认消息');
    await store.waitMessage(session.id, { timeoutMs: 100 });
    expect(readdirSync(join(root, 'sessions', session.id, 'processing'))).toHaveLength(1);

    store.reply(session.id, '已处理', { suggestions: ['继续验证'], title: '确认测试' });
    expect(readdirSync(join(root, 'sessions', session.id, 'processing'))).toHaveLength(0);
    expect(store.getSession(session.id).title).toBe('确认测试');
    expect(store.getHistory(session.id).at(-1)?.metadata?.suggestions).toEqual(['继续验证']);
  });

  it('requeues an abandoned processing message after the claim lease expires', async () => {
    const leased = new XjFileStore(root, { claimTimeoutMs: 5 });
    const { session } = leased.register({ clientKey: 'crash-client', title: 'Crash' });
    leased.enqueueUserMessage(session.id, '不能丢失');
    const first = await leased.waitMessage(session.id, { timeoutMs: 100 });
    expect(first.kind).toBe('message');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const recovered = new XjFileStore(root, { claimTimeoutMs: 5 });
    const second = await recovered.waitMessage(session.id, { timeoutMs: 100 });
    expect(second.kind).toBe('message');
    expect(second.message?.id).toBe(first.message?.id);
    expect(second.message?.content).toBe('不能丢失');
  });

  it('pause and resume survive a new store instance', () => {
    const { session } = store.register({ clientKey: 'client-e', title: 'E' });
    store.setAutomation(session.id, {
      enabled: true,
      state: 'running',
      loopLimit: 12,
      acceptanceCriteria: ['unit tests pass'],
    });
    store.pause(session.id);

    const restored = new XjFileStore(root, { staleAfterMs: 24 * 60 * 60 * 1000 });
    expect(restored.getAutomation(session.id).state).toBe('paused');
    restored.resume(session.id);
    expect(restored.getAutomation(session.id).state).toBe('running');
  });

  it('partial automation updates preserve frozen criteria and running state', () => {
    const { session } = store.register({ clientKey: 'client-f', title: 'F' });
    store.setAutomation(session.id, {
      enabled: true,
      state: 'running',
      loopLimit: 20,
      acceptanceCriteria: ['tests', 'build'],
    });
    const next = store.setAutomation(session.id, {
      enabled: undefined,
      state: undefined,
      loopLimit: 30,
      acceptanceCriteria: undefined,
    });

    expect(next.enabled).toBe(true);
    expect(next.state).toBe('running');
    expect(next.acceptanceCriteria).toEqual(['tests', 'build']);
    expect(next.loopLimit).toBe(30);
  });

  it('freezes acceptance criteria once an automation run starts', () => {
    const { session } = store.register({ clientKey: 'client-g', title: 'G' });
    store.setAutomation(session.id, {
      enabled: true,
      state: 'running',
      acceptanceCriteria: ['tests pass'],
    });

    expect(() => store.setAutomation(session.id, { acceptanceCriteria: ['easier target'] }))
      .toThrow('acceptance_criteria_frozen');
  });

  it('does not complete while frozen criteria or todo remain', () => {
    const { session } = store.register({ clientKey: 'gate-client', title: 'Gate' });
    store.setAutomation(session.id, {
      enabled: true,
      state: 'running',
      acceptanceCriteria: ['tests pass'],
      completedCriteria: [],
      todo: ['run tests'],
    });

    expect(() => store.completeSession(session.id, { summary: 'premature', evidence: [] }))
      .toThrow('completion_gates_not_met');
    expect(store.getSession(session.id).status).not.toBe('completed');

    store.setAutomation(session.id, { completedCriteria: ['tests pass'], todo: [] });
    store.reportProgress(session.id, { percent: 90, summary: 'still verifying', todo: ['collect final evidence'] });
    expect(() => store.completeSession(session.id, { summary: 'still premature', evidence: [] }))
      .toThrow('completion_gates_not_met');
  });

  it('keeps paused and completed sessions terminal without another wait instruction', async () => {
    const paused = store.register({ clientKey: 'paused-client', title: 'Paused' }).session;
    store.pause(paused.id);
    const pausedWait = await store.waitMessage(paused.id, { timeoutMs: 10 });
    expect(pausedWait).toMatchObject({ kind: 'paused', continueWith: null });
    expect(store.getSession(paused.id).status).toBe('paused');

    const completed = store.register({ clientKey: 'done-client', title: 'Done' }).session;
    store.completeSession(completed.id, { summary: 'done', evidence: ['tests'] });
    const completedWait = await store.waitMessage(completed.id, { timeoutMs: 10 });
    expect(completedWait).toMatchObject({ kind: 'completed', continueWith: null });
    expect(store.getSession(completed.id).status).toBe('completed');
  });

  it('transitions an abandoned active session offline while retaining its reconnect ID', async () => {
    const expiring = new XjFileStore(root, { offlineAfterMs: 5, staleAfterMs: 24 * 60 * 60 * 1000 });
    const { session } = expiring.register({ launchId: 'xjlaunch-offline', name: '离线测试' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const offline = expiring.getSession(session.id);
    expect(offline.status).toBe('offline');
    expect(new Date(offline.reconnectUntil).getTime()).toBeGreaterThan(Date.now());
    expect(expiring.register({ launchId: 'xjlaunch-offline', name: '离线测试' }).session.id).toBe(session.id);
  });
});
