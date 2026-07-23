import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createXjMcpServer } from '../../src/xj/mcp-server.js';
import { XjSkillRouter } from '../../src/xj/skill-router.js';
import { XjFileStore } from '../../src/xj/store.js';

describe('XJ stdio MCP protocol', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('offers register, wait, reply, progress and automation tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polarcop-xj-mcp-'));
    roots.push(root);
    const store = new XjFileStore(root);
    const server = createXjMcpServer({ store, skillRouter: new XjSkillRouter(join(root, 'skills')) });
    const client = new Client({ name: 'xj-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'register_session', 'register_legacy_session', 'wait_message', 'reply_message', 'report_progress', 'update_automation', 'complete_session',
      'list_subagents', 'dispatch_subagent_task',
    ]));
    const registerTool = tools.tools.find((tool) => tool.name === 'register_session');
    const registerSchema = registerTool?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(registerSchema.required).toEqual(expect.arrayContaining(['launchId', 'name']));
    expect(Object.keys(registerSchema.properties ?? {})).not.toContain('client_key');
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain('continuous_session');

    const registered = await client.callTool({ name: 'register_legacy_session', arguments: { client_key: 'mcp-client', title: 'MCP' } });
    const text = (registered.content as Array<{ type: string; text: string }>)[0]?.text ?? '{}';
    const body = JSON.parse(text) as { session: { id: string }; application_instructions: string };
    expect(body.session.id).toMatch(/^xj-/);
    expect(body.application_instructions).toContain('wait_message');

    store.enqueueUserMessage(body.session.id, '实现下一步');
    const waited = await client.callTool({ name: 'wait_message', arguments: { session_id: body.session.id, timeout_ms: 1000 } });
    const waitBody = JSON.parse((waited.content as Array<{ text: string }>)[0]!.text) as { kind: string; message: { content: string } };
    expect(waitBody.kind).toBe('message');
    expect(waitBody.message.content).toBe('实现下一步');

    await client.close();
    await server.close();
  });

  it('lists two linked subagents and completes the dispatch-result loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polarcop-xj-mcp-subagents-'));
    roots.push(root);
    const store = new XjFileStore(root);
    const family = store.ensureSessionFamily({
      launchId: 'xjlaunch-mcp-family',
      name: '通用 Agent',
      role: 'general-purpose',
      title: 'MCP 编队',
    }, 2);
    const server = createXjMcpServer({ store, skillRouter: new XjSkillRouter(join(root, 'skills')) });
    const client = new Client({ name: 'xj-subagent-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.callTool({
      name: 'list_subagents', arguments: { sessionId: family.session.id },
    });
    const listBody = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text) as {
      subagents: Array<{ id: string }>;
    };
    expect(listBody.subagents).toHaveLength(2);

    const dispatched = await client.callTool({
      name: 'dispatch_subagent_task',
      arguments: {
        sessionId: family.session.id,
        subagentId: listBody.subagents[0]!.id,
        title: '独立检查',
        content: '检查持久化边界',
      },
    });
    const dispatchBody = JSON.parse((dispatched.content as Array<{ text: string }>)[0]!.text) as {
      task: { id: string };
    };
    const childWait = await client.callTool({
      name: 'wait_message', arguments: { sessionId: listBody.subagents[0]!.id, timeoutMs: 100 },
    });
    const childBody = JSON.parse((childWait.content as Array<{ text: string }>)[0]!.text) as {
      message: { content: string };
    };
    expect(childBody.message.content).toBe('检查持久化边界');
    await client.callTool({
      name: 'reply_message',
      arguments: { sessionId: listBody.subagents[0]!.id, content: '边界检查完成' },
    });
    const mainWait = await client.callTool({
      name: 'wait_message', arguments: { sessionId: family.session.id, timeoutMs: 100 },
    });
    const mainBody = JSON.parse((mainWait.content as Array<{ text: string }>)[0]!.text) as {
      message: { content: string; metadata: { taskId: string } };
    };
    expect(mainBody.message.content).toContain('边界检查完成');
    expect(mainBody.message.metadata.taskId).toBe(dispatchBody.task.id);

    await client.close();
    await server.close();
  });

  it('accepts the original XJ launch prompt parameter names and reply metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polarcop-xj-mcp-compat-'));
    roots.push(root);
    const store = new XjFileStore(root);
    const server = createXjMcpServer({ store, skillRouter: new XjSkillRouter(join(root, 'skills')) });
    const client = new Client({ name: 'xj-compat-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const registered = await client.callTool({
      name: 'register_session',
      arguments: {
        name: '通用 Agent',
        role: 'general-purpose',
        launchId: 'xjlaunch-1784831456675-2f32d105',
        modes: ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'],
      },
    });
    const registerBody = JSON.parse((registered.content as Array<{ text: string }>)[0]!.text) as {
      sessionId: string;
      name: string;
    };
    expect(registerBody.sessionId).toMatch(/^xj-mcp-agent-/);
    expect(registerBody.name).toBe('通用 Agent');

    await client.callTool({
      name: 'wait_message',
      arguments: { sessionId: registerBody.sessionId, agentStatus: 'waiting', timeoutMs: 1 },
    });
    expect(store.getSession(registerBody.sessionId).agentStatus).toBe('waiting');

    await client.callTool({
      name: 'reply_message',
      arguments: {
        sessionId: registerBody.sessionId,
        content: '已接入',
        agentStatus: 'ready',
        title: '通用任务',
        suggestions: ['开始任务', '进入夜间挂机'],
      },
    });
    const session = store.getSession(registerBody.sessionId);
    expect(session.title).toBe('通用任务');
    expect(session.agentStatus).toBe('ready');
    expect(store.getHistory(registerBody.sessionId).at(-1)?.metadata?.suggestions)
      .toEqual(['开始任务', '进入夜间挂机']);

    await client.close();
    await server.close();
  });

  it('rejects complete_session until acceptance gates pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'polarcop-xj-mcp-gate-'));
    roots.push(root);
    const store = new XjFileStore(root);
    const server = createXjMcpServer({ store, skillRouter: new XjSkillRouter(join(root, 'skills')) });
    const client = new Client({ name: 'xj-gate-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const session = store.register({ clientKey: 'gate-mcp', title: 'Gate' }).session;
    store.setAutomation(session.id, { enabled: true, state: 'running', acceptanceCriteria: ['tests'], todo: ['run tests'] });

    const result = await client.callTool({ name: 'complete_session', arguments: { session_id: session.id, summary: 'not done' } });
    expect(result.isError).toBe(true);
    expect(store.getSession(session.id).status).not.toBe('completed');

    await client.close();
    await server.close();
  });
});
