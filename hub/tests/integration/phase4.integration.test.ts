import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

describe('phase 4 — path leases & config', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-phase4-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('grants lease, conflicts second holder, and releases', async () => {
    const hub = await startHub(join(workDir, 'leases.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'a1' });
      const g1 = parseToolJson(
        await callTool(c1, 'hub_acquire_lease', {
          agent_id: 'a1',
          path: 'src/foo.ts',
          ttl_ms: 600_000,
        }),
      );
      expect(g1.status).toBe('granted');
      const leaseId = (g1.lease as { lease_id: string }).lease_id;
      expect(leaseId).toBeTruthy();
    });

    await withClient(hub.baseUrl, async (c2) => {
      await callTool(c2, 'hub_register', { agent_id: 'a2' });
      const g2 = parseToolJson(
        await callTool(c2, 'hub_acquire_lease', {
          agent_id: 'a2',
          path: 'src/foo.ts',
          ttl_ms: 600_000,
        }),
      );
      expect(g2.status).toBe('conflict');
    });

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'a1' });
      const chk = parseToolJson(await callTool(c1, 'hub_check_lease', { path: 'src/foo.ts' }));
      expect(chk.lease).toBeTruthy();
      const rel = parseToolJson(
        await callTool(c1, 'hub_release_lease', { agent_id: 'a1', path: 'src/foo.ts' }),
      );
      expect(rel.released).toBe(true);
    });

    await withClient(hub.baseUrl, async (c2) => {
      await callTool(c2, 'hub_register', { agent_id: 'a2' });
      const g3 = parseToolJson(
        await callTool(c2, 'hub_acquire_lease', {
          agent_id: 'a2',
          path: 'src/foo.ts',
          ttl_ms: 600_000,
        }),
      );
      expect(g3.status).toBe('granted');
    });

    await hub.close();
  });

  it('persists and version-updates config.json', async () => {
    const hub = await startHub(join(workDir, 'cfg.sqlite'), workDir);

    await withClient(hub.baseUrl, async (client) => {
      await callTool(client, 'hub_register', { agent_id: 'cfg' });
      const g0 = parseToolJson(await callTool(client, 'hub_get_config', {}));
      expect(g0.ok).toBe(true);
      const v0 = (g0.config as { version: number }).version;

      const up = parseToolJson(
        await callTool(client, 'hub_update_config', {
          agent_id: 'cfg',
          expected_version: v0,
          patch: { automation_preset: 'semi_auto' },
        }),
      );
      expect(up.status).toBe('success');
      expect((up.config as { version: number }).version).toBe(v0 + 1);

      const raw = readFileSync(join(workDir, 'config.json'), 'utf8');
      expect(raw).toContain('semi_auto');

      const bad = parseToolJson(
        await callTool(client, 'hub_update_config', {
          agent_id: 'cfg',
          expected_version: v0,
          patch: { automation_preset: 'full_auto' },
        }),
      );
      expect(bad.status).toBe('conflict');
    });

    await hub.close();
  });
});
