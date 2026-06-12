/**
 * Agent-C E2E: Phase 3 — task lifecycle, leases, DAG deps, split → parent auto-done, workflow filters.
 */
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

type TaskRow = {
  id: string;
  status: string;
  owner_agent_id: string | null;
  parent_task_id: string | null;
  depends_on: string[];
  workflow_stage: string;
};

function parseToolJson(result: unknown): Record<string, unknown> {
  const r = CallToolResultSchema.parse(result);
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as { type: 'text'; text: string } | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'e2e-tasks', version: '0.0.0' });
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

describe('e2e phase 3 — tasks', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-p3-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('lifecycle: create → claim → heartbeat → complete', async () => {
    const hub = await startHub(join(workDir, 'life.sqlite'), workDir);

    let taskId = '';
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-creator' });
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-creator',
          title: 'e2e lifecycle',
          workflow_stage: 'execute',
          priority: 10,
        }),
      );
      expect(created.ok).toBe(true);
      taskId = (created.task as TaskRow).id;
      expect((created.task as TaskRow).status).toBe('open');
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-worker' });
      const claimed = parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'e2e-worker',
          lease_duration_ms: 600_000,
          heartbeat_interval_ms: 60_000,
        }),
      );
      expect(claimed.ok).toBe(true);
      const t = claimed.task as TaskRow | null;
      expect(t).not.toBeNull();
      expect(t!.id).toBe(taskId);
      expect(t!.status).toBe('claimed');

      const beat = parseToolJson(
        await callTool(c, 'hub_heartbeat_task', {
          agent_id: 'e2e-worker',
          task_id: taskId,
          lease_extend_ms: 120_000,
        }),
      );
      expect(beat.ok).toBe(true);
      expect((beat.task as TaskRow).status).toBe('claimed');

      const done = parseToolJson(
        await callTool(c, 'hub_complete_task', {
          agent_id: 'e2e-worker',
          task_id: taskId,
          result_summary: 'ok',
        }),
      );
      expect(done.ok).toBe(true);
      expect((done.task as TaskRow).status).toBe('done');
    });

    await hub.close();
  });

  it('lease expiry: stale claim returns to pool for another agent', async () => {
    const hub = await startHub(join(workDir, 'lease.sqlite'), workDir);
    let taskId = '';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-setup' });
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-setup',
          title: 'lease probe',
          workflow_stage: 'plan',
          priority: 5,
        }),
      );
      taskId = (created.task as TaskRow).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-slow' });
      const claimed = parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'e2e-slow',
          lease_duration_ms: 150,
          heartbeat_interval_ms: 60_000,
        }),
      );
      expect((claimed.task as TaskRow | null)?.id).toBe(taskId);
    });

    await new Promise((r) => setTimeout(r, 350));

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-pickup' });
      const second = parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'e2e-pickup',
          lease_duration_ms: 600_000,
        }),
      );
      const t = second.task as TaskRow | null;
      expect(t).not.toBeNull();
      expect(t!.id).toBe(taskId);
      expect(t!.owner_agent_id).toBe('e2e-pickup');
    });

    await hub.close();
  });

  it('dependencies: downstream not claimable until upstream done', async () => {
    const hub = await startHub(join(workDir, 'dep.sqlite'), workDir);
    let idA = '';
    let idB = '';

    await withClient(hub.baseUrl, async (boss) => {
      await callTool(boss, 'hub_register', { agent_id: 'e2e-boss' });
      const a = parseToolJson(
        await callTool(boss, 'hub_create_task', {
          creator_agent_id: 'e2e-boss',
          title: 'A',
          workflow_stage: 'execute',
          priority: 1,
        }),
      );
      idA = (a.task as TaskRow).id;
      const b = parseToolJson(
        await callTool(boss, 'hub_create_task', {
          creator_agent_id: 'e2e-boss',
          title: 'B',
          workflow_stage: 'execute',
          priority: 2,
          depends_on: [idA],
        }),
      );
      idB = (b.task as TaskRow).id;
    });

    await withClient(hub.baseUrl, async (w) => {
      await callTool(w, 'hub_register', { agent_id: 'e2e-dep-worker' });
      const onlyBReady = parseToolJson(
        await callTool(w, 'hub_list_tasks', { ready_only: true, workflow_stage: 'execute' }),
      );
      const readyIds = (onlyBReady.tasks as TaskRow[]).map((t) => t.id);
      expect(readyIds).toContain(idA);
      expect(readyIds).not.toContain(idB);

      const claimWrong = parseToolJson(await callTool(w, 'hub_claim_task', { agent_id: 'e2e-dep-worker', lease_duration_ms: 600_000 }));
      const t0 = claimWrong.task as TaskRow | null;
      expect(t0?.id).toBe(idA);

      await callTool(w, 'hub_complete_task', { agent_id: 'e2e-dep-worker', task_id: idA });

      const after = parseToolJson(
        await callTool(w, 'hub_list_tasks', { ready_only: true, workflow_stage: 'execute' }),
      );
      expect((after.tasks as TaskRow[]).some((t) => t.id === idB)).toBe(true);

      const claimB = parseToolJson(await callTool(w, 'hub_claim_task', { agent_id: 'e2e-dep-worker', lease_duration_ms: 600_000 }));
      expect((claimB.task as TaskRow).id).toBe(idB);
    });

    await hub.close();
  });

  it('split: three children all done → parent auto done', async () => {
    const hub = await startHub(join(workDir, 'split.sqlite'), workDir);
    let parentId = '';
    const childIds: string[] = [];

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-splitter' });
      const p = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-splitter',
          title: 'parent',
          workflow_stage: 'execute',
          priority: 0,
        }),
      );
      parentId = (p.task as TaskRow).id;

      const sp = parseToolJson(
        await callTool(c, 'hub_split_task', {
          agent_id: 'e2e-splitter',
          parent_task_id: parentId,
          /** Higher than parent (0) so scheduler does not hand out the parent before children. */
          children: [
            { title: 'c1', priority: 5 },
            { title: 'c2', priority: 5 },
            { title: 'c3', priority: 5 },
          ],
        }),
      );
      expect(sp.ok).toBe(true);
      for (const ch of sp.children as TaskRow[]) {
        childIds.push(ch.id);
      }
      expect(childIds).toHaveLength(3);
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-finisher' });
      const pending = new Set(childIds);
      while (pending.size > 0) {
        const cl = parseToolJson(
          await callTool(c, 'hub_claim_task', {
            agent_id: 'e2e-finisher',
            workflow_stage: 'execute',
            lease_duration_ms: 600_000,
          }),
        );
        const t = cl.task as TaskRow | null;
        expect(t).not.toBeNull();
        expect(pending.has(t!.id)).toBe(true);
        await callTool(c, 'hub_complete_task', { agent_id: 'e2e-finisher', task_id: t!.id });
        pending.delete(t!.id);
      }

      const list = parseToolJson(await callTool(c, 'hub_list_tasks', { limit: 50 }));
      const parent = (list.tasks as TaskRow[]).find((t) => t.id === parentId);
      expect(parent?.status).toBe('done');
    });

    await hub.close();
  });

  it('workflow_stage filter on claim', async () => {
    const hub = await startHub(join(workDir, 'stage.sqlite'), workDir);
    let executeId = '';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-stager' });
      await callTool(c, 'hub_create_task', {
        creator_agent_id: 'e2e-stager',
        title: 'discuss only',
        workflow_stage: 'discuss',
        priority: 99,
      });
      const ex = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-stager',
          title: 'execute only',
          workflow_stage: 'execute',
          priority: 1,
        }),
      );
      executeId = (ex.task as TaskRow).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-specialist' });
      const got = parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'e2e-specialist',
          workflow_stage: 'execute',
          lease_duration_ms: 600_000,
        }),
      );
      const t = got.task as TaskRow | null;
      expect(t).not.toBeNull();
      expect(t!.workflow_stage).toBe('execute');
      expect(t!.id).toBe(executeId);
    });

    await hub.close();
  });
});
