/**
 * Agent-C E2E: Phase 6 — audit log, health (stale agent via DB aging), progress rollup,
 * hub_set_limits, and SafetyLimiter semantics (hub 进程内全工具拦截未接线时由 limiter 单测兜底)。
 */
import Database from 'better-sqlite3';
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
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as { type: 'text'; text: string } | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'e2e-p6', version: '0.0.0' });
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

type RunningHub = { baseUrl: string; dbPath: string; close: () => Promise<void> };

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

  return { baseUrl, dbPath, close };
}

describe('e2e phase 6 — safety & observability', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-p6-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('hub_set_limits + audit log entries', async () => {
    const hub = await startHub(join(workDir, 'audit.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-audit-agent' });
      const lim = parseToolJson(
        await callTool(c, 'hub_set_limits', {
          agent_id: 'e2e-audit-agent',
          limits: {
            max_tool_calls: 50,
            max_tokens: 1_000_000,
            max_wall_time_ms: 3_600_000,
          },
        }),
      );
      expect(lim.status).toBe('success');

      const log = parseToolJson(
        await callTool(c, 'hub_get_audit_log', {
          limit: 50,
          agent_id: 'e2e-audit-agent',
        }),
      );
      expect(log.ok).toBe(true);
      const entries = log.entries as { action: string }[];
      expect(entries.some((e) => e.action === 'hub.register')).toBe(true);
      expect(entries.some((e) => e.action === 'hub.set_limits')).toBe(true);
    });

    await hub.close();
  });

  it('hub_get_progress aggregates by workflow stage', async () => {
    const hub = await startHub(join(workDir, 'progress.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-prog-boss' });
      await callTool(c, 'hub_create_task', {
        creator_agent_id: 'e2e-prog-boss',
        title: 'done task',
        workflow_stage: 'execute',
        priority: 1,
      });
      const t = parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'e2e-prog-boss', lease_duration_ms: 600_000 }),
      );
      const id = (t.task as { id: string }).id;
      await callTool(c, 'hub_complete_task', { agent_id: 'e2e-prog-boss', task_id: id });

      const agg = parseToolJson(await callTool(c, 'hub_get_progress', {}));
      expect(agg.ok).toBe(true);
      const rows = agg.by_phase as { phase: string; completed: number; total: number }[];
      const ex = rows.find((r) => r.phase === 'execute');
      expect(ex).toBeDefined();
      expect((ex?.completed ?? 0) >= 1).toBe(true);
    });

    await hub.close();
  });

  it('health reports stale agent after aging last_ping_at (DB replay)', async () => {
    const dbPath = join(workDir, 'stale.sqlite');
    let hub = await startHub(dbPath, workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-stale-victim' });
    });
    await hub.close();

    const raw = new Database(dbPath);
    raw.prepare(`UPDATE sessions SET last_ping_at = ? WHERE agent_id = ?`).run(1, 'e2e-stale-victim');
    raw.close();

    hub = await startHub(dbPath, workDir);
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-stale-observer' });
      const h = parseToolJson(await callTool(c, 'hub_get_health', {}));
      expect(h.ok).toBe(true);
      const health = h.health as { stale_agents: string[] };
      expect(health.stale_agents).toContain('e2e-stale-victim');
    });
    await hub.close();
  });

  it('SafetyLimiter enforces max_tool_calls (class behavior)', () => {
    const dbPath = join(workDir, 'limiter-isolated.sqlite');
    mkdirSync(dirname(dbPath), { recursive: true });
    const { sqlite, db } = createHubDatabase(dbPath);
    try {
      const lim = new SafetyLimiter(db);
      const out = lim.setPersisted('cap-agent', {
        max_tool_calls: 2,
        max_tokens: 9999,
        max_wall_time_ms: 86_400_000,
      });
      expect(out.status).toBe('success');
      expect(lim.check('cap-agent').ok).toBe(true);
      lim.recordToolCall('cap-agent');
      expect(lim.check('cap-agent').ok).toBe(true);
      lim.recordToolCall('cap-agent');
      const denied = lim.check('cap-agent');
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.reason).toBe('max_tool_calls_exceeded');
    } finally {
      sqlite.close();
    }
  });

  it('hub_get_health returns expected shape', async () => {
    const hub = await startHub(join(workDir, 'health-shape.sqlite'), workDir);
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-health-a' });
      const h = parseToolJson(await callTool(c, 'hub_get_health', {}));
      const health = h.health as Record<string, unknown>;
      expect(Array.isArray(health.stale_agents)).toBe(true);
      expect(typeof health.queue_depth).toBe('number');
      expect(typeof health.active_tasks).toBe('number');
      expect(Array.isArray(health.anomalies)).toBe(true);
    });
    await hub.close();
  });
});
