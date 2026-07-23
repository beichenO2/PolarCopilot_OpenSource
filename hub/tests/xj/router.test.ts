import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createXjRouter } from '../../src/xj/router.js';
import { XjFileStore } from '../../src/xj/store.js';
import { XjSkillRouter } from '../../src/xj/skill-router.js';

describe('XJ UI API', () => {
  let root: string;
  let baseUrl: string;
  let server: Server;
  let routerStore: XjFileStore;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'polarcop-xj-api-'));
    const skillRoot = mkdtempSync(join(tmpdir(), 'polarcop-xj-api-skills-'));
    const app = express();
    app.use(express.json());
    routerStore = new XjFileStore(root);
    app.use('/api', createXjRouter({
      store: routerStore,
      skillRouter: new XjSkillRouter(skillRoot),
      storeBridgeIntervalMs: 10,
    }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('missing port');
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it('creates, lists and restores stable sessions', async () => {
    const created = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_key: 'api-client', title: 'API' }),
    });
    expect(created.status).toBe(201);
    const first = await created.json() as { session: { id: string }; deduplicated: boolean };
    const restored = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_key: 'api-client', title: 'API restored' }),
    });
    const second = await restored.json() as { session: { id: string }; deduplicated: boolean };
    expect(second.session.id).toBe(first.session.id);
    expect(second.deduplicated).toBe(true);

    const list = await fetch(`${baseUrl}/api/ui/xj/sessions`).then((r) => r.json()) as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);
  });

  it('issues a launchId session token from HUB Web and reuses it', async () => {
    const payload = {
      launchId: 'xjlaunch-web-issued-token',
      name: '通用 Agent',
      role: 'general-purpose',
      modes: ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'],
      subagent_count: 2,
    };
    const created = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then((response) => response.json()) as {
      session: { id: string; launchId: string; modes: string[]; agentSlot: string };
      subagents: Array<{ id: string; parentSessionId: string; agentSlot: string }>;
    };
    const restored = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }).then((response) => response.json()) as { session: { id: string } };

    expect(created.session.id).toMatch(/^xj-mcp-agent-/);
    expect(created.session.launchId).toBe(payload.launchId);
    expect(created.session.modes).toEqual(payload.modes);
    expect(created.session.agentSlot).toBe('main');
    expect(created.subagents).toHaveLength(2);
    expect(created.subagents.every((session) => session.parentSessionId === created.session.id)).toBe(true);
    expect(restored.session.id).toBe(created.session.id);
  });

  it('normalizes stale Web clients to the generic 1+2 family contract', async () => {
    const created = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        launchId: 'xjlaunch-stale-web-client',
        name: '资深全栈架构师',
        role: 'fullstack-architect',
        title: '旧页面请求',
        modes: ['夜晚自动化挂机任务'],
      }),
    }).then((response) => response.json()) as {
      session: { name: string; role: string; agentSlot: string };
      subagents: Array<{ parentSessionId: string }>;
    };

    expect(created.session).toMatchObject({
      name: '通用 Agent',
      role: 'general-purpose',
      agentSlot: 'main',
    });
    expect(created.subagents).toHaveLength(2);
  });

  it('always routes a Web task to the main Agent even when a child is selected', async () => {
    const family = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ launchId: 'xjlaunch-main-task-router' }),
    }).then((response) => response.json()) as {
      session: { id: string };
      subagents: Array<{ id: string }>;
    };

    const sent = await fetch(`${baseUrl}/api/ui/xj/sessions/${family.subagents[0]!.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '一次输入完成整项任务' }),
    }).then((response) => response.json()) as { message: { sessionId: string } };

    expect(sent.message.sessionId).toBe(family.session.id);
    expect(routerStore.getHistory(family.session.id).at(-1)?.content).toBe('一次输入完成整项任务');
    expect(routerStore.getHistory(family.subagents[0]!.id)).toHaveLength(0);
  });

  it('bridges a reply written by the separate stdio store process to browser SSE', async () => {
    const session = routerStore.register({ launchId: 'xjlaunch-sse-bridge', name: 'SSE' }).session;
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/ui/xj/stream`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const stdioStore = new XjFileStore(root);
    stdioStore.reply(session.id, '跨进程回复');

    const decoder = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 1_000;
    while (!received.includes('event: xj_store_changed') && Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) => setTimeout(() => resolve({ done: true }), 100)),
      ]);
      if (!result.done && result.value) received += decoder.decode(result.value);
    }
    controller.abort();
    expect(received).toContain('event: xj_store_changed');
  });

  it('queues messages and exposes Markdown history and progress', async () => {
    const created = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_key: 'message-client', title: 'Messages' }),
    }).then((r) => r.json()) as { session: { id: string } };
    const id = created.session.id;

    const sent = await fetch(`${baseUrl}/api/ui/xj/sessions/${id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# 开始\n继续执行' }),
    });
    expect(sent.status).toBe(201);

    const detail = await fetch(`${baseUrl}/api/ui/xj/sessions/${id}`).then((r) => r.json()) as {
      history: Array<{ content: string }>;
      session: { status: string };
      progress: { percent: number };
    };
    expect(detail.history.at(-1)?.content).toContain('# 开始');
    expect(detail.session.status).toBe('pending');
    expect(detail.progress.percent).toBe(0);
  });

  it('manages modes and pause/resume automation controls', async () => {
    const created = await fetch(`${baseUrl}/api/ui/xj/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_key: 'mode-client', title: 'Modes' }),
    }).then((r) => r.json()) as { session: { id: string } };
    const id = created.session.id;
    const configured = await fetch(`${baseUrl}/api/ui/xj/sessions/${id}/automation`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, state: 'running', loop_limit: 9, acceptance_criteria: ['build'] }),
    });
    expect(configured.status).toBe(200);
    await fetch(`${baseUrl}/api/ui/xj/sessions/${id}/pause`, { method: 'POST' });
    const paused = await fetch(`${baseUrl}/api/ui/xj/sessions/${id}`).then((r) => r.json()) as { automation: { state: string } };
    expect(paused.automation.state).toBe('paused');
    await fetch(`${baseUrl}/api/ui/xj/sessions/${id}/resume`, { method: 'POST' });
    const resumed = await fetch(`${baseUrl}/api/ui/xj/sessions/${id}`).then((r) => r.json()) as { automation: { state: string; loopLimit: number } };
    expect(resumed.automation.state).toBe('running');
    expect(resumed.automation.loopLimit).toBe(9);
  });
});
