/**
 * Agent-C E2E: Phase 2 — broadcast (SSE + poll), planning state OCC, idempotency.
 * Black-box style against Streamable HTTP + REST SSE, isolated temp DB + mirror root.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const client = new Client({ name: 'e2e-client', version: '0.0.0' });
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

function httpOriginFromMcpBase(mcpBase: string): string {
  return mcpBase.replace(/\/mcp$/, '');
}

async function readFirstSseDataPayload(streamUrl: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const res = await fetch(streamUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    throw new Error(`sse_http_${res.status}`);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    while (true) {
      const sep = buf.indexOf('\n\n');
      if (sep < 0) break;
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      if (block.startsWith(':')) continue;
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (line) {
        return JSON.parse(line.slice('data:'.length).trim()) as Record<string, unknown>;
      }
    }
  }
  throw new Error('no_sse_data_payload');
}

describe('e2e phase 2 — broadcast & planning state', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-p2-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('SSE: agent-1 publishes, agent-2 receives', async () => {
    const hub = await startHub(join(workDir, 'sse.sqlite'), workDir);
    const origin = httpOriginFromMcpBase(hub.baseUrl);

    let sessionB = '';
    await withClient(hub.baseUrl, async (c2) => {
      const reg = parseToolJson(await callTool(c2, 'hub_register', { agent_id: 'e2e-agent-2' }));
      expect(reg.ok).toBe(true);
      sessionB = reg.session_id as string;
    });

    const streamUrl = `${origin}/hub/events/stream?mcp_session_id=${encodeURIComponent(sessionB)}`;
    const ssePromise = readFirstSseDataPayload(streamUrl, 15_000);
    await new Promise((r) => setTimeout(r, 200));

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'e2e-agent-1' });
      await callTool(c1, 'hub_publish', {
        agent_id: 'e2e-agent-1',
        topic: 'e2e.broadcast',
        payload: { seq: 1 },
      });
    });

    const evt = await ssePromise;
    expect(evt.topic).toBe('e2e.broadcast');
    expect(evt.agent_id).toBe('e2e-agent-1');

    await hub.close();
  });

  it('poll: after disconnect, reconnecting subscriber retrieves missed events', async () => {
    const hub = await startHub(join(workDir, 'reconnect.sqlite'), workDir);

    await withClient(hub.baseUrl, async (sub) => {
      await callTool(sub, 'hub_register', { agent_id: 'e2e-sub' });
    });

    await withClient(hub.baseUrl, async (pub) => {
      await callTool(pub, 'hub_register', { agent_id: 'e2e-pub' });
      await callTool(pub, 'hub_publish', {
        agent_id: 'e2e-pub',
        topic: 'while_offline',
        payload: { missed: true },
      });
    });

    await withClient(hub.baseUrl, async (sub2) => {
      await callTool(sub2, 'hub_register', { agent_id: 'e2e-sub' });
      const polled = parseToolJson(await callTool(sub2, 'hub_poll_events', { agent_id: 'e2e-sub', limit: 50 }));
      expect(polled.ok).toBe(true);
      const evs = polled.events as { topic: string; payload: unknown }[];
      expect(evs.some((e) => e.topic === 'while_offline' && (e.payload as { missed: boolean }).missed === true)).toBe(
        true,
      );
    });

    await hub.close();
  });

  it('planning state: concurrent writes — one success, one conflict', async () => {
    const hub = await startHub(join(workDir, 'occ-e2e.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c0) => {
      await callTool(c0, 'hub_register', { agent_id: 'e2e-seed' });
      await callTool(c0, 'hub_state_write', {
        path: '.planning/e2e-conflict.md',
        content: 'v0',
        expected_version: 0,
        updated_by: 'e2e-seed',
      });
    });

    const [ra, rb] = await Promise.all([
      withClient(hub.baseUrl, async (c1) => {
        await callTool(c1, 'hub_register', { agent_id: 'e2e-wa' });
        return parseToolJson(
          await callTool(c1, 'hub_state_write', {
            path: '.planning/e2e-conflict.md',
            content: 'A',
            expected_version: 1,
            updated_by: 'e2e-wa',
          }),
        );
      }),
      withClient(hub.baseUrl, async (c2) => {
        await callTool(c2, 'hub_register', { agent_id: 'e2e-wb' });
        return parseToolJson(
          await callTool(c2, 'hub_state_write', {
            path: '.planning/e2e-conflict.md',
            content: 'B',
            expected_version: 1,
            updated_by: 'e2e-wb',
          }),
        );
      }),
    ]);

    const outcomes = [(ra.result as { status: string }).status, (rb.result as { status: string }).status];
    expect(outcomes.filter((s) => s === 'success')).toHaveLength(1);
    expect(outcomes.filter((s) => s === 'conflict')).toHaveLength(1);

    const mirrored = join(workDir, '.planning/e2e-conflict.md');
    expect(existsSync(mirrored)).toBe(true);
    const body = readFileSync(mirrored, 'utf8');
    expect(body === 'A' || body === 'B').toBe(true);

    await hub.close();
  });

  it('idempotency: duplicate hub_publish with same key is deduplicated', async () => {
    const hub = await startHub(join(workDir, 'idem-pub-e2e.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'e2e-idem-pub' });
      const a = parseToolJson(
        await callTool(c1, 'hub_publish', {
          agent_id: 'e2e-idem-pub',
          topic: 'once',
          payload: { n: 1 },
          idempotency_key: 'e2e-key-pub',
        }),
      );
      const b = parseToolJson(
        await callTool(c1, 'hub_publish', {
          agent_id: 'e2e-idem-pub',
          topic: 'once',
          payload: { n: 2 },
          idempotency_key: 'e2e-key-pub',
        }),
      );
      expect(a.deduplicated).toBeFalsy();
      expect(b.deduplicated).toBe(true);
      expect((a.event as { payload: { n: number } }).payload.n).toBe(1);
    });

    await hub.close();
  });
});
