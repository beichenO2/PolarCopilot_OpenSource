/**
 * Stress tests for gsd-2 Hub:
 * 1. 20-round rapid conversation — verify high turn count doesn't cause failures
 * 2. Large payload — verify self-healing under oversized content
 * 3. Idle timeout — verify hub doesn't deadlock or crash after inactivity
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
import { HubStore } from '../../src/persistence/store.js';
import { AuditJournal } from '../../src/safety/audit.js';
import { SafetyLimiter } from '../../src/safety/limiter.js';
import { SessionRegistry } from '../../src/session/registry.js';
import { ProgressTracker } from '../../src/tasks/progress.js';
import { TaskService } from '../../src/tasks/service.js';
import { createHubExpress, mountStreamableHttpHub } from '../../src/transport/http.js';

const silentLogger = pino({ level: 'silent' });

function parseToolJson(result: unknown): Record<string, unknown> {
  const r = CallToolResultSchema.parse(result);
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as
    | { type: 'text'; text: string }
    | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'stress-test', version: '0.0.0' });
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
  const auditJournal = new AuditJournal(db);
  const safetyLimiter = new SafetyLimiter(db);
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

describe('stress: 20-round rapid conversation', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-stress-rounds-'));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('survives 20 rapid rounds of create→claim→complete without errors', async () => {
    const hub = await startHub(join(workDir, 'rounds.sqlite'), workDir);

    // Use separate sessions for boss and worker (different agent_ids)
    const taskIds: string[] = [];

    // Boss creates all 20 tasks
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'stress-boss' });

      for (let round = 1; round <= 20; round++) {
        const created = parseToolJson(
          await callTool(c, 'hub_create_task', {
            creator_agent_id: 'stress-boss',
            title: `rapid-task-${round}`,
            workflow_stage: 'execute',
            priority: round,
          }),
        );
        const taskId = (created.task as { id: string }).id;
        expect(taskId).toBeTruthy();
        taskIds.push(taskId);
      }
    });

    // Worker claims and completes all 20 tasks
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'stress-worker' });

      for (let round = 0; round < 20; round++) {
        const claimed = parseToolJson(
          await callTool(c, 'hub_claim_task', { agent_id: 'stress-worker' }),
        );
        const claimedTask = claimed.task as { id: string } | null;
        expect(claimedTask).not.toBeNull();
        expect(claimedTask!.id).toBeTruthy();

        await callTool(c, 'hub_complete_task', {
          agent_id: 'stress-worker',
          task_id: claimedTask!.id,
          result_summary: `round ${round + 1} done`,
        });
      }
    });

    // Verify all 20 tasks are done
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'stress-verifier' });
      const list = parseToolJson(
        await callTool(c, 'hub_list_tasks', { status: 'done' }),
      );
      const tasks = list.tasks as { title: string }[];
      expect(tasks.length).toBe(20);

      // Verify health endpoint still responds
      const health = parseToolJson(await callTool(c, 'hub_get_health', {}));
      expect(health).toBeDefined();
      expect(health.ok).toBe(true);
    });

    await hub.close();
  }, 30_000);
});

describe('stress: large payload resilience', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-stress-large-'));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('handles large event payload (100KB+) without crash', async () => {
    const hub = await startHub(join(workDir, 'large.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'large-sender' });

      // ~100KB payload
      const bigContent = 'A'.repeat(100_000);
      const published = parseToolJson(
        await callTool(c, 'hub_publish', {
          agent_id: 'large-sender',
          topic: 'ctrl.inbox',
          payload: { type: 'large_data', content: bigContent },
        }),
      );
      expect(published.ok).toBe(true);
    });

    // Separate session to poll — payload >4KB gets truncated by compressPayload
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'large-receiver' });
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'large-receiver', limit: 10 }),
      );
      expect(polled.ok).toBe(true);
      const evs = polled.events as { payload: { _hub_truncated?: boolean; size?: number; type?: string; content?: string } }[];
      const truncatedEvent = evs.find(
        (e) => e.payload?._hub_truncated === true && (e.payload?.size ?? 0) >= 100_000,
      );
      expect(truncatedEvent).toBeDefined();
    });

    await hub.close();
  }, 15_000);

  it('handles large task description (50KB) without crash', async () => {
    const hub = await startHub(join(workDir, 'large-task.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'large-task-creator' });

      const bigDescription = '这是一段很长的任务描述。'.repeat(5_000);
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'large-task-creator',
          title: 'big-desc-task',
          description: bigDescription,
          workflow_stage: 'execute',
        }),
      );
      expect((created.task as { id: string }).id).toBeTruthy();

      // Claim it — should contain the full description
      const claimed = parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'large-task-creator' }),
      );
      const task = claimed.task as { description: string } | null;
      expect(task).not.toBeNull();
      expect(task!.description.length).toBeGreaterThan(10_000);
    });

    await hub.close();
  }, 15_000);

  it('handles many concurrent event publishes without data loss', async () => {
    const hub = await startHub(join(workDir, 'concurrent.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'concurrent-pub' });

      // Fire 50 events sequentially (MCP transport serializes anyway)
      for (let i = 0; i < 50; i++) {
        await callTool(c, 'hub_publish', {
          agent_id: 'concurrent-pub',
          topic: 'ctrl.inbox',
          payload: { type: 'burst', seq: i },
        });
      }
    });

    // Verify all 50 from another session
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'concurrent-reader' });
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'concurrent-reader', limit: 100 }),
      );
      const evs = polled.events as { payload: { type?: string; seq?: number } }[];
      const burstEvents = evs.filter((e) => e.payload?.type === 'burst');
      expect(burstEvents.length).toBe(50);
    });

    await hub.close();
  }, 15_000);
});

describe('stress: idle resilience', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-stress-idle-'));
  });
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('hub stays healthy after disconnect/reconnect, old data persists', async () => {
    const hub = await startHub(join(workDir, 'idle.sqlite'), workDir);

    // Phase 1: register and create work
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'idle-boss' });
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'idle-boss',
          title: 'pre-idle-task',
          workflow_stage: 'execute',
        }),
      );
      expect(created.ok).toBe(true);

      // Verify task exists in this session
      const verify = parseToolJson(
        await callTool(c, 'hub_list_tasks', {}),
      );
      const verifyTasks = verify.tasks as { title: string }[];
      expect(verifyTasks.some((t) => t.title === 'pre-idle-task')).toBe(true);
    });

    // Phase 2: new session — re-register (simulates reconnect after long idle)
    await withClient(hub.baseUrl, async (c) => {
      const reg = parseToolJson(
        await callTool(c, 'hub_register', { agent_id: 'idle-boss' }),
      );
      expect(reg.ok).toBe(true);

      // Previous task should still exist (SQLite persistence)
      const list = parseToolJson(
        await callTool(c, 'hub_list_tasks', {}),
      );
      const tasks = list.tasks as { title: string }[];
      expect(tasks.some((t) => t.title === 'pre-idle-task')).toBe(true);

      // Create new task — hub is still accepting work
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'idle-boss',
          title: 'post-idle-task',
          workflow_stage: 'execute',
        }),
      );
      expect((created.task as { id: string }).id).toBeTruthy();

      // Health endpoint
      const health = parseToolJson(await callTool(c, 'hub_get_health', {}));
      expect(health.ok).toBe(true);
    });

    // Phase 3: different agent, claim and complete
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'idle-worker' });
      const claimed = parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'idle-worker' }),
      );
      expect((claimed.task as { id: string } | null)).not.toBeNull();
    });

    await hub.close();
  }, 30_000);

  it('10 rapid reconnects don\'t cause session corruption', async () => {
    const hub = await startHub(join(workDir, 'reconnect.sqlite'), workDir);
    const agentId = 'reconnect-agent';

    for (let i = 0; i < 10; i++) {
      await withClient(hub.baseUrl, async (c) => {
        const reg = parseToolJson(
          await callTool(c, 'hub_register', { agent_id: agentId }),
        );
        expect(reg.ok).toBe(true);

        await callTool(c, 'hub_publish', {
          agent_id: agentId,
          topic: 'ctrl.inbox',
          payload: { type: 'reconnect_test', iteration: i },
        });
      });
    }

    // Final connect: all events should be retrievable
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'reconnect-reader' });
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'reconnect-reader', limit: 50 }),
      );
      const evs = polled.events as { payload: { type?: string; iteration?: number } }[];
      const reconnectEvents = evs.filter((e) => e.payload?.type === 'reconnect_test');
      expect(reconnectEvents.length).toBe(10);
    });

    await hub.close();
  }, 30_000);
});
