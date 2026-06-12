import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { BroadcastPublisher } from '../../src/broadcast/publisher.js';
import { SseHub } from '../../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../../src/broadcast/subscriber.js';
import { createHubDatabase } from '../../src/persistence/db.js';
import { PathLeaseService } from '../../src/persistence/path-leases.js';
import { AuditJournal } from '../../src/safety/audit.js';
import { SafetyLimiter } from '../../src/safety/limiter.js';
import { HubStore } from '../../src/persistence/store.js';
import { SessionRegistry } from '../../src/session/registry.js';
import { ProgressTracker } from '../../src/tasks/progress.js';
import { TaskService } from '../../src/tasks/service.js';
import { createHubExpress, mountStreamableHttpHub } from '../../src/transport/http.js';

const silentLogger = pino({ level: 'silent' });

function parseToolJson(result: unknown): Record<string, unknown> {
  const r = CallToolResultSchema.parse(result);
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as { type: 'text'; text: string } | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return client.request(
    {
      method: 'tools/call',
      params: { name, arguments: args },
    },
    CallToolResultSchema,
  );
}

type RunningHub = { baseUrl: string; close: () => Promise<void> };

async function startHub(dbPath: string, mirrorRoot: string): Promise<RunningHub> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const { sqlite, db } = createHubDatabase(dbPath);
  const store = new HubStore(db);
  const registry = new SessionRegistry(store, silentLogger);
  const sseHub = new SseHub();
  const eventSubscriber = new EventSubscriber();
  const publisher = new BroadcastPublisher(store, sseHub, eventSubscriber);
  const taskService = new TaskService(db, sqlite, store);
  const pathLeaseService = new PathLeaseService(db);
  const progressTracker = new ProgressTracker();
  const safetyLimiter = new SafetyLimiter(db);
  const auditJournal = new AuditJournal(db);
  const app = createHubExpress();
  mountStreamableHttpHub(app, {
    store,
    registry,
    ctx: { logger: silentLogger, hubStartedAt: new Date() },
    sseHub,
    publisher,
    eventSubscriber,
    mirrorRoot,
    taskService,
    pathLeaseService,
    progressTracker,
    safetyLimiter,
    auditJournal,
    hubDb: db,
  });

  let server: Server;
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(`http://127.0.0.1:${addr.port}/mcp`);
      } else {
        reject(new Error('no listen address'));
      }
    });
    server.on('error', reject);
  });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        try {
          sqlite.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve();
      });
    });

  return { baseUrl, close };
}

describe('phase 3 — tasks, leases, dependencies, split', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-phase3-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs create → claim → heartbeat → complete', async () => {
    const hub = await startHub(join(workDir, 'lifecycle.sqlite'), workDir);

    await withClient(hub.baseUrl, async (client) => {
      await callTool(client, 'hub_register', { agent_id: 'worker' });

      const created = parseToolJson(
        await callTool(client, 'hub_create_task', {
          creator_agent_id: 'worker',
          title: 'hello',
          workflow_stage: 'execute',
          priority: 5,
        }),
      );
      expect(created.ok).toBe(true);

      const claimed = parseToolJson(
        await callTool(client, 'hub_claim_task', {
          agent_id: 'worker',
          lease_duration_ms: 600_000,
        }),
      );
      expect(claimed.ok).toBe(true);
      const task = claimed.task as { id: string };
      expect(task?.id).toBeTruthy();

      const beat = parseToolJson(
        await callTool(client, 'hub_heartbeat_task', {
          agent_id: 'worker',
          task_id: task.id,
          lease_extend_ms: 120_000,
        }),
      );
      expect(beat.ok).toBe(true);

      const done = parseToolJson(
        await callTool(client, 'hub_complete_task', {
          agent_id: 'worker',
          task_id: task.id,
        }),
      );
      expect(done.ok).toBe(true);
      expect((done.task as { status: string }).status).toBe('done');
    });

    await hub.close();
  });

  it('returns leased tasks to the pool after lease expiry', async () => {
    const hub = await startHub(join(workDir, 'lease.sqlite'), workDir);

    await withClient(hub.baseUrl, async (client) => {
      await callTool(client, 'hub_register', { agent_id: 'lease-agent' });

      parseToolJson(
        await callTool(client, 'hub_create_task', {
          creator_agent_id: 'lease-agent',
          title: 'short',
          workflow_stage: 'execute',
          priority: 1,
        }),
      );

      const c1 = parseToolJson(
        await callTool(client, 'hub_claim_task', {
          agent_id: 'lease-agent',
          lease_duration_ms: 35,
        }),
      );
      const id = (c1.task as { id: string }).id;
      expect(id).toBeTruthy();

      await new Promise((r) => setTimeout(r, 120));

      const c2 = parseToolJson(
        await callTool(client, 'hub_claim_task', {
          agent_id: 'lease-agent',
          lease_duration_ms: 600_000,
        }),
      );
      expect((c2.task as { id: string }).id).toBe(id);
    });

    await hub.close();
  });

  it('blocks claims until dependencies are done', async () => {
    const hub = await startHub(join(workDir, 'deps.sqlite'), workDir);

    await withClient(hub.baseUrl, async (client) => {
      await callTool(client, 'hub_register', { agent_id: 'dworker' });

      const a = parseToolJson(
        await callTool(client, 'hub_create_task', {
          creator_agent_id: 'dworker',
          title: 'A',
          workflow_stage: 'execute',
          priority: 2,
        }),
      );
      const aid = (a.task as { id: string }).id;

      parseToolJson(
        await callTool(client, 'hub_create_task', {
          creator_agent_id: 'dworker',
          title: 'B',
          workflow_stage: 'execute',
          priority: 3,
          depends_on: [aid],
        }),
      );

      const first = parseToolJson(await callTool(client, 'hub_claim_task', { agent_id: 'dworker' }));
      expect((first.task as { id: string }).id).toBe(aid);

      const blocked = parseToolJson(await callTool(client, 'hub_claim_task', { agent_id: 'dworker' }));
      expect(blocked.task).toBeNull();

      parseToolJson(
        await callTool(client, 'hub_complete_task', { agent_id: 'dworker', task_id: aid }),
      );

      const second = parseToolJson(await callTool(client, 'hub_claim_task', { agent_id: 'dworker' }));
      expect((second.task as { id: string }).id).not.toBe(aid);
    });

    await hub.close();
  });

  it('auto-completes parent when all children are done', async () => {
    const hub = await startHub(join(workDir, 'split.sqlite'), workDir);

    await withClient(hub.baseUrl, async (client) => {
      await callTool(client, 'hub_register', { agent_id: 'splitter' });

      const p = parseToolJson(
        await callTool(client, 'hub_create_task', {
          creator_agent_id: 'splitter',
          title: 'parent',
          workflow_stage: 'execute',
          priority: 0,
        }),
      );
      const parentId = (p.task as { id: string }).id;

      const sp = parseToolJson(
        await callTool(client, 'hub_split_task', {
          agent_id: 'splitter',
          parent_task_id: parentId,
          children: [
            { title: 'c1', priority: 10, workflow_stage: 'execute' },
            { title: 'c2', priority: 10, workflow_stage: 'execute' },
          ],
        }),
      );
      expect((sp.children as unknown[]).length).toBe(2);

      const t1 = parseToolJson(await callTool(client, 'hub_claim_task', { agent_id: 'splitter' }));
      const id1 = (t1.task as { id: string }).id;
      parseToolJson(await callTool(client, 'hub_complete_task', { agent_id: 'splitter', task_id: id1 }));

      const t2 = parseToolJson(await callTool(client, 'hub_claim_task', { agent_id: 'splitter' }));
      const id2 = (t2.task as { id: string }).id;
      parseToolJson(await callTool(client, 'hub_complete_task', { agent_id: 'splitter', task_id: id2 }));

      const listed = parseToolJson(
        await callTool(client, 'hub_list_tasks', { limit: 50, workflow_stage: 'execute' }),
      );
      const tasks = listed.tasks as { id: string; status: string }[];
      const parent = tasks.find((t) => t.id === parentId);
      expect(parent?.status).toBe('done');
    });

    await hub.close();
  });
});
