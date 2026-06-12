/**
 * Agent-C E2E: Phase 4 — path leases (conflict signal) and config.json (versioned update, TTL from config).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const client = new Client({ name: 'e2e-p4', version: '0.0.0' });
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

describe('e2e phase 4 — leases & config', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-p4-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('path lease: second agent gets conflict with holder metadata', async () => {
    const hub = await startHub(join(workDir, 'lease.sqlite'), workDir);
    const path = 'src/shared.ts';

    const a1 = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-lease-a' });
      return parseToolJson(
        await callTool(c, 'hub_acquire_lease', {
          agent_id: 'e2e-lease-a',
          path,
          ttl_ms: 120_000,
        }),
      );
    });
    expect(a1.status).toBe('granted');

    const a2 = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-lease-b' });
      return parseToolJson(
        await callTool(c, 'hub_acquire_lease', {
          agent_id: 'e2e-lease-b',
          path,
          ttl_ms: 120_000,
        }),
      );
    });
    expect(a2.status).toBe('conflict');
    const holder = a2.holder as { agent_id: string; path: string };
    expect(holder.agent_id).toBe('e2e-lease-a');
    expect(holder.path).toBe(path);

    await hub.close();
  });

  it('config: hub_update_config bumps version; hub_acquire_lease picks default_lease_ttl_ms', async () => {
    const hub = await startHub(join(workDir, 'cfg.sqlite'), workDir);
    const ttl = 77_777;

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-cfg' });
      const cur = parseToolJson(await callTool(c, 'hub_get_config', {}));
      expect(cur.ok).toBe(true);
      const v0 = cur.config as { version: number };
      const out = parseToolJson(
        await callTool(c, 'hub_update_config', {
          agent_id: 'e2e-cfg',
          expected_version: v0.version,
          patch: { default_lease_ttl_ms: ttl },
        }),
      );
      expect(out.status).toBe('success');
      const cfg = out.config as { version: number; default_lease_ttl_ms: number };
      expect(cfg.version).toBe(v0.version + 1);
      expect(cfg.default_lease_ttl_ms).toBe(ttl);

      const granted = parseToolJson(
        await callTool(c, 'hub_acquire_lease', {
          agent_id: 'e2e-cfg',
          path: 'docs/readme.md',
        }),
      );
      expect(granted.status).toBe('granted');
      const lease = granted.lease as { expires_at: string; created_at: string };
      const exp = new Date(lease.expires_at).getTime();
      const created = new Date(lease.created_at).getTime();
      expect(exp - created).toBeGreaterThanOrEqual(ttl - 2000);
      expect(exp - created).toBeLessThanOrEqual(ttl + 2000);
    });

    await hub.close();
  });

  it('intervention matrix: switching to interactive preset (all block) persists on disk', async () => {
    const hub = await startHub(join(workDir, 'matrix.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-mx' });
      const cur = parseToolJson(await callTool(c, 'hub_get_config', {}));
      const v = (cur.config as { version: number }).version;
      const up = parseToolJson(
        await callTool(c, 'hub_update_config', {
          agent_id: 'e2e-mx',
          expected_version: v,
          patch: { automation_preset: 'interactive' },
        }),
      );
      expect(up.status).toBe('success');
      const im = (up.config as { intervention_matrix: Record<string, string> }).intervention_matrix;
      expect(im.execute).toBe('block');
      expect(im.discuss).toBe('block');
    });

    const raw = JSON.parse(readFileSync(join(workDir, 'config.json'), 'utf8')) as {
      automation_preset: string;
      intervention_matrix: { execute: string };
    };
    expect(raw.automation_preset).toBe('interactive');
    expect(raw.intervention_matrix.execute).toBe('block');

    await hub.close();
  });

  it('hot reload from disk: edit config.json and next hub_get_config sees change', async () => {
    const hub = await startHub(join(workDir, 'hot.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'e2e-hot' });
      const before = parseToolJson(await callTool(c, 'hub_get_config', {}));
      const cfg0 = before.config as { version: number; automation_preset?: string };
      writeFileSync(
        join(workDir, 'config.json'),
        JSON.stringify(
          {
            version: cfg0.version + 10,
            automation_preset: 'interactive',
            intervention_matrix: {
              discuss: 'block',
              research: 'block',
              plan: 'block',
              execute: 'block',
              verify: 'block',
            },
          },
          null,
          2,
        ),
      );

      const after = parseToolJson(await callTool(c, 'hub_get_config', {}));
      const cfg1 = after.config as { automation_preset: string };
      expect(cfg1.automation_preset).toBe('interactive');
    });

    await hub.close();
  });
});
