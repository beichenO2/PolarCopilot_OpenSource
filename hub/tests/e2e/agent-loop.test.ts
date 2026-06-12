/**
 * Agent-C E2E: Phase 5 — checkpoint, handoff (same stable agent_id), progress / simulated retry, help broadcast.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as { type: 'text'; text: string } | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'e2e-p5', version: '0.0.0' });
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

describe('e2e phase 5 — agent loop & handoff', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-p5-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const stableWorker = 'e2e-stable-worker';

  it('mini loop: claim → progress → checkpoint → complete', async () => {
    const hub = await startHub(join(workDir, 'loop.sqlite'), workDir);
    let taskId = '';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-boss' });
      const t = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-boss',
          title: 'loop me',
          workflow_stage: 'execute',
          priority: 3,
        }),
      );
      taskId = (t.task as { id: string }).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: stableWorker });
      const claimed = parseToolJson(await callTool(c, 'hub_claim_task', { agent_id: stableWorker, lease_duration_ms: 600_000 }));
      expect((claimed.task as { id: string }).id).toBe(taskId);

      const s = parseToolJson(
        await callTool(c, 'hub_report_progress', {
          agent_id: stableWorker,
          task_id: taskId,
          kind: 'started',
        }),
      );
      expect(s.recorded).toBe(true);

      const cp = parseToolJson(
        await callTool(c, 'hub_checkpoint', {
          agent_id: stableWorker,
          task_id: taskId,
          progress_summary: 'did partial work',
          context_snapshot: { files: ['a.ts'] },
        }),
      );
      expect(cp.ok).toBe(true);
      const diskPath = join(workDir, '.planning/hub/checkpoints', `${stableWorker}_${taskId}.json`);
      expect(existsSync(diskPath)).toBe(true);

      const mid = parseToolJson(
        await callTool(c, 'hub_report_progress', {
          agent_id: stableWorker,
          task_id: taskId,
          kind: 'progress',
          pct: 50,
          message: 'halfway',
        }),
      );
      expect((mid.loop as { iteration: number }).iteration).toBeGreaterThanOrEqual(1);

      await callTool(c, 'hub_complete_task', { agent_id: stableWorker, task_id: taskId });

      const fin = parseToolJson(
        await callTool(c, 'hub_report_progress', {
          agent_id: stableWorker,
          task_id: taskId,
          kind: 'done',
        }),
      );
      expect((fin.loop as { status: string }).status).toBe('waiting');
    });

    await hub.close();
  });

  it('handoff: new session with same agent_id reads checkpoint package', async () => {
    const hub = await startHub(join(workDir, 'handoff.sqlite'), workDir);
    let taskId = '';
    const agent = 'e2e-handoff-agent';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-h-boss' });
      const t = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-h-boss',
          title: 'handoff task',
          workflow_stage: 'execute',
          priority: 2,
        }),
      );
      taskId = (t.task as { id: string }).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: agent });
      await callTool(c, 'hub_claim_task', { agent_id: agent, lease_duration_ms: 600_000 });
      await callTool(c, 'hub_checkpoint', {
        agent_id: agent,
        task_id: taskId,
        progress_summary: 'saved for peer',
        context_snapshot: { step: 2 },
      });
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: agent });
      const pkg = parseToolJson(await callTool(c, 'hub_handoff', { agent_id: agent, task_id: taskId }));
      expect(pkg.ok).toBe(true);
      const p = pkg.package as {
        task_id: string;
        checkpoint: { progress_summary: string };
        remaining_steps: string[];
      };
      expect(p.task_id).toBe(taskId);
      expect(p.checkpoint.progress_summary).toBe('saved for peer');
      expect(p.remaining_steps.length).toBeGreaterThan(0);
    });

    await hub.close();
  });

  it('simulated retry: error → progress → loop iteration advances', async () => {
    const hub = await startHub(join(workDir, 'retry.sqlite'), workDir);
    let taskId = '';
    const agent = 'e2e-retry-agent';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-r-boss' });
      const t = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-r-boss',
          title: 'flaky',
          workflow_stage: 'execute',
          priority: 1,
        }),
      );
      taskId = (t.task as { id: string }).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: agent });
      await callTool(c, 'hub_claim_task', { agent_id: agent, lease_duration_ms: 600_000 });

      const err = parseToolJson(
        await callTool(c, 'hub_report_progress', {
          agent_id: agent,
          task_id: taskId,
          kind: 'error',
          message: 'transient',
        }),
      );
      expect((err.loop as { status: string }).status).toBe('error');

      const retry = parseToolJson(
        await callTool(c, 'hub_report_progress', {
          agent_id: agent,
          task_id: taskId,
          kind: 'progress',
          message: 'recovered',
        }),
      );
      expect((retry.loop as { iteration: number }).iteration).toBeGreaterThanOrEqual(1);
      expect((retry.loop as { status: string }).status).toBe('working');

      await callTool(c, 'hub_complete_task', { agent_id: agent, task_id: taskId });
    });

    await hub.close();
  });

  it('hub_request_help publishes durable event', async () => {
    const hub = await startHub(join(workDir, 'help.sqlite'), workDir);
    let taskId = '';

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-help-boss' });
      const t = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'e2e-help-boss',
          title: 'needs help',
          workflow_stage: 'execute',
          priority: 0,
        }),
      );
      taskId = (t.task as { id: string }).id;
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-help' });
      const out = parseToolJson(
        await callTool(c, 'hub_request_help', {
          agent_id: 'e2e-help',
          task_id: taskId,
          topic: 'ci',
          summary: 'build red on main',
        }),
      );
      expect(out.ok).toBe(true);
      const b = out.broadcast as { topic: string };
      expect(b.topic.startsWith('help.')).toBe(true);
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-help-sub' });
      const polled = parseToolJson(await callTool(c, 'hub_poll_events', { agent_id: 'e2e-help-sub', limit: 20 }));
      const evs = polled.events as { topic: string }[];
      expect(evs.some((e) => e.topic.startsWith('help.'))).toBe(true);
    });

    await hub.close();
  });
});
