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

type RunningHub = {
  store: HubStore;
  baseUrl: string;
  close: () => Promise<void>;
};

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

  return { store, baseUrl, close };
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

describe('phase 2 — broadcast, planning state, idempotency', () => {
  let workDir: string;
  let dbPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-phase2-'));
    dbPath = join(workDir, 'hub.sqlite');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('delivers broadcast over SSE to another agent', async () => {
    const hub = await startHub(dbPath, workDir);
    const origin = httpOriginFromMcpBase(hub.baseUrl);

    let sessionB = '';
    await withClient(hub.baseUrl, async (c2) => {
      const reg = parseToolJson(await callTool(c2, 'hub_register', { agent_id: 'agent-b' }));
      expect(reg.ok).toBe(true);
      sessionB = reg.session_id as string;
    });

    const streamUrl = `${origin}/hub/events/stream?mcp_session_id=${encodeURIComponent(sessionB)}`;
    const ssePromise = readFirstSseDataPayload(streamUrl, 15_000);
    await new Promise((r) => setTimeout(r, 200));

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'agent-a' });
      await callTool(c1, 'hub_publish', { agent_id: 'agent-a', topic: 'demo', payload: { hello: 'world' } });
    });

    const evt = await ssePromise;
    expect(evt.topic).toBe('demo');
    expect(evt.agent_id).toBe('agent-a');

    await hub.close();
  });

  it('poll fallback returns events with cursor advancement', async () => {
    const hub = await startHub(join(workDir, 'poll.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'pub' });
      await callTool(c1, 'hub_publish', { agent_id: 'pub', topic: 't2', payload: { k: 2 } });
    });

    await withClient(hub.baseUrl, async (c2) => {
      await callTool(c2, 'hub_register', { agent_id: 'sub' });
      const first = parseToolJson(await callTool(c2, 'hub_poll_events', { agent_id: 'sub', limit: 50 }));
      expect(first.ok).toBe(true);
      const evs = first.events as { topic: string }[];
      expect(evs.length).toBeGreaterThanOrEqual(1);
      expect(evs.some((e) => e.topic === 't2')).toBe(true);
      const cursor = first.cursor as string;

      const second = parseToolJson(
        await callTool(c2, 'hub_poll_events', { agent_id: 'sub', after_event_id: cursor, limit: 50 }),
      );
      expect((second.events as unknown[]).length).toBe(0);
    });

    await hub.close();
  });

  it('rejects concurrent optimistic writes (single winner)', async () => {
    const hub = await startHub(join(workDir, 'occ.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c0) => {
      await callTool(c0, 'hub_register', { agent_id: 'seed' });
      await callTool(c0, 'hub_state_write', {
        path: '.planning/conflict.md',
        content: 'v1',
        expected_version: 0,
        updated_by: 'seed',
      });
    });

    const [ra, rb] = await Promise.all([
      withClient(hub.baseUrl, async (c1) => {
        await callTool(c1, 'hub_register', { agent_id: 'wa' });
        return parseToolJson(
          await callTool(c1, 'hub_state_write', {
            path: '.planning/conflict.md',
            content: '2a',
            expected_version: 1,
            updated_by: 'wa',
          }),
        );
      }),
      withClient(hub.baseUrl, async (c2) => {
        await callTool(c2, 'hub_register', { agent_id: 'wb' });
        return parseToolJson(
          await callTool(c2, 'hub_state_write', {
            path: '.planning/conflict.md',
            content: '2b',
            expected_version: 1,
            updated_by: 'wb',
          }),
        );
      }),
    ]);

    const outcomes = [
      ra.result as { status: string },
      rb.result as { status: string },
    ];
    expect(outcomes.filter((o) => o.status === 'success')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'conflict')).toHaveLength(1);

    const mirrored = join(workDir, '.planning/conflict.md');
    expect(existsSync(mirrored)).toBe(true);
    const body = readFileSync(mirrored, 'utf8');
    expect(body === '2a' || body === '2b').toBe(true);

    await hub.close();
  });

  it('deduplicates hub_publish via idempotency_key', async () => {
    const hub = await startHub(join(workDir, 'idem-pub.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'idem' });
      const a = parseToolJson(
        await callTool(c1, 'hub_publish', {
          agent_id: 'idem',
          topic: 'once',
          payload: { n: 1 },
          idempotency_key: 'k-pub-1',
        }),
      );
      const b = parseToolJson(
        await callTool(c1, 'hub_publish', {
          agent_id: 'idem',
          topic: 'once',
          payload: { n: 999 },
          idempotency_key: 'k-pub-1',
        }),
      );
      expect(a.deduplicated).toBeFalsy();
      expect(b.deduplicated).toBe(true);
      expect((a.event as { payload: { n: number } }).payload.n).toBe(1);
      expect((b.event as { payload: { n: number } }).payload.n).toBe(1);
    });

    await hub.close();
  });

  it('deduplicates hub_state_write via idempotency_key', async () => {
    const hub = await startHub(join(workDir, 'idem-state.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c1) => {
      await callTool(c1, 'hub_register', { agent_id: 'writer' });
      const a = parseToolJson(
        await callTool(c1, 'hub_state_write', {
          path: '.planning/idem.md',
          content: 'alpha',
          expected_version: 0,
          updated_by: 'writer',
          idempotency_key: 'k-state-1',
        }),
      );
      const b = parseToolJson(
        await callTool(c1, 'hub_state_write', {
          path: '.planning/idem.md',
          content: 'beta',
          expected_version: 0,
          updated_by: 'writer',
          idempotency_key: 'k-state-1',
        }),
      );
      expect((a.result as { status: string }).status).toBe('success');
      expect(b.result).toEqual(a.result);

      const doc = parseToolJson(await callTool(c1, 'hub_state_read', { path: '.planning/idem.md' }));
      const d = doc.document as { content: string; version: number };
      expect(d.content).toBe('alpha');
      expect(d.version).toBe(1);
    });

    await hub.close();
  });
});
