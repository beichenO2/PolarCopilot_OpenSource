import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createRrMcpServer } from '../../src/rr/mcp-server.js';
import { makePollTick } from '../../src/rr/poll-ticks.js';
import { RrFileStore } from '../../src/rr/store.js';

const TOOL_NAMES = [
  'register_session',
  'reply_message',
  'wait_message',
  'list_subagents',
  'dispatch_subagent_task',
  'report_task_progress',
  'complete_subagent_task',
];

describe('Rr MCP compatibility contract', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  async function harness() {
    const root = mkdtempSync(join(tmpdir(), 'rr-mcp-'));
    roots.push(root);
    const store = new RrFileStore(root);
    const server = createRrMcpServer(store);
    const client = new Client({ name: 'rr-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { store, server, client };
  }

  it('exposes only the seven compatible tools and original argument names', async () => {
    const { server, client } = await harness();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    const schemas = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
    expect(schemas.register_session.required).toEqual(['name']);
    expect(schemas.dispatch_subagent_task.required).toEqual(['sessionId', 'targetSessionId', 'content']);
    expect(schemas.report_task_progress.required).toEqual(['sessionId', 'taskId', 'progress']);
    expect(schemas.complete_subagent_task.required).toEqual(['sessionId', 'taskId', 'result']);
    await client.close();
    await server.close();
  });

  it('dispatches, reports and completes with a persistent busy lock', async () => {
    const { store, server, client } = await harness();
    const main = store.register({ name: 'Main' }).session;
    const child = store.register({ name: 'Child' }).session;
    store.setSubagent(child.sessionId, true);

    const dispatched = await client.callTool({
      name: 'dispatch_subagent_task',
      arguments: { sessionId: main.sessionId, targetSessionId: child.sessionId, content: 'inspect locally' },
    });
    const dispatchText = (dispatched.content as Array<{ text: string }>)[0]!.text;
    const taskId = dispatchText.match(/taskId=(rr-task-[0-9a-f-]+)/)?.[1];
    expect(taskId).toBeTruthy();
    expect(store.listSubagents(main.sessionId)[0]?.availability).toBe('busy');

    const childWait = await client.callTool({ name: 'wait_message', arguments: { sessionId: child.sessionId } });
    expect((childWait.content as Array<{ text: string }>)[0]!.text).toContain('[RR_MSG · AGENT_TASK]');
    await client.callTool({
      name: 'report_task_progress',
      arguments: { sessionId: child.sessionId, taskId, progress: 'checked', percent: 50 },
    });
    expect(store.listSubagents(main.sessionId)[0]?.activeTask?.progress?.percent).toBe(50);
    await client.callTool({
      name: 'complete_subagent_task',
      arguments: { sessionId: child.sessionId, taskId, result: 'done', ok: true },
    });
    expect(store.listSubagents(main.sessionId)[0]?.availability).toBe('idle');
    const mainWait = await client.callTool({ name: 'wait_message', arguments: { sessionId: main.sessionId } });
    expect((mainWait.content as Array<{ text: string }>)[0]!.text).toContain('[RR_MSG · AGENT_RESULT]');

    await client.close();
    await server.close();
  });

  it('creates branded changing poll ticks', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-poll-'));
    roots.push(root);
    const tick = makePollTick(new RrFileStore(root));
    expect(tick).toContain('[POLL_TICK]');
    expect(tick).toContain('[RR_MSG · KEEPALIVE]');
    expect(tick).not.toContain('XJ');
  });

  it('locks user-renamed title against reply_message and register name overwrite', async () => {
    const { store, server, client } = await harness();
    const session = store.register({ name: 'Rr Agent · 主', launchId: 'rrlaunch-lock-1' }).session;
    store.updateSession(session.sessionId, { title: '我的固定名', titleLocked: true });
    expect(store.getSession(session.sessionId).title).toBe('我的固定名');
    expect(store.getSession(session.sessionId).titleLocked).toBe(true);

    await client.callTool({
      name: 'reply_message',
      arguments: { sessionId: session.sessionId, content: 'hello', title: '任务标题覆盖' },
    });
    expect(store.getSession(session.sessionId).title).toBe('我的固定名');

    // Hub 自动 stamp（不带 titleLocked）不得覆盖
    store.updateSession(session.sessionId, { title: '主 · stamp-auto' });
    expect(store.getSession(session.sessionId).title).toBe('我的固定名');

    const reReg = store.register({
      sessionId: session.sessionId,
      launchId: 'rrlaunch-lock-1',
      name: 'Agent 想改的名字',
    });
    expect(reReg.session.name).toBe('Rr Agent · 主');
    expect(reReg.session.title).toBe('我的固定名');

    // 用户再次重命名仍可改
    store.updateSession(session.sessionId, { title: '第二次人工名', titleLocked: true });
    expect(store.getSession(session.sessionId).title).toBe('第二次人工名');

    await client.close();
    await server.close();
  });

  it('lists sessions by createdAt not lastActiveAt', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-sort-'));
    roots.push(root);
    const store = new RrFileStore(root);
    const older = store.register({ name: 'Older' }).session;
    const newer = store.register({ name: 'Newer' }).session;
    // 强制拉开创建时间，避免同毫秒撞车；并让 older 的 lastActiveAt 更大
    const olderPath = join(root, 'sessions', `${older.sessionId}.json`);
    const newerPath = join(root, 'sessions', `${newer.sessionId}.json`);
    const olderRaw = JSON.parse(readFileSync(olderPath, 'utf8')) as typeof older;
    const newerRaw = JSON.parse(readFileSync(newerPath, 'utf8')) as typeof newer;
    writeFileSync(olderPath, `${JSON.stringify({ ...olderRaw, createdAt: 1_000, lastActiveAt: 9_000 }, null, 2)}\n`);
    writeFileSync(newerPath, `${JSON.stringify({ ...newerRaw, createdAt: 2_000, lastActiveAt: 2_100 }, null, 2)}\n`);
    const ids = store.listSessions().map((session) => session.sessionId);
    expect(ids.indexOf(newer.sessionId)).toBeLessThan(ids.indexOf(older.sessionId));
  });
});

