import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { BroadcastPublisher } from '../src/broadcast/publisher.js';
import { SseHub } from '../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../src/broadcast/subscriber.js';
import { createHubDatabase } from '../src/persistence/db.js';
import { PathLeaseService } from '../src/persistence/path-leases.js';
import { AuditJournal } from '../src/safety/audit.js';
import { SafetyLimiter } from '../src/safety/limiter.js';
import { HubStore } from '../src/persistence/store.js';
import { SessionRegistry } from '../src/session/registry.js';
import { ProgressTracker } from '../src/tasks/progress.js';
import { TaskService } from '../src/tasks/service.js';
import { createHubExpress, mountStreamableHttpHub } from '../src/transport/http.js';

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

describe('gsd-2 hub', () => {
  let workDir: string;
  let dbPath: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-hub-test-'));
    dbPath = join(workDir, 'hub.sqlite');
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs two independent MCP sessions with distinct agent_id and session_id', async () => {
    const hub = await startHub(dbPath, workDir);

    const p1 = withClient(hub.baseUrl, async (c1) => {
      const reg = parseToolJson(await callTool(c1, 'hub_register', { agent_id: 'agent-one', label: 'A' }));
      expect(reg.ok).toBe(true);
      expect(reg.agent_id).toBe('agent-one');
      expect(typeof reg.session_id).toBe('string');
      const s1 = reg.session_id as string;

      const st = parseToolJson(await callTool(c1, 'hub_status', { include_payloads: true }));
      expect(st.ok).toBe(true);
      expect((st as { session?: { agent_id?: string } }).session?.agent_id).toBe('agent-one');

      return s1;
    });

    const p2 = withClient(hub.baseUrl, async (c2) => {
      const reg = parseToolJson(await callTool(c2, 'hub_register', { agent_id: 'agent-two' }));
      expect(reg.ok).toBe(true);
      expect(reg.agent_id).toBe('agent-two');
      return reg.session_id as string;
    });

    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1).not.toBe(s2);

    await hub.close();
  });

  it('persists messages across reconnect and survives db reopen (crash-style restart)', async () => {
    const dbFile = join(workDir, 'restart.sqlite');
    for (const ext of ['', '-wal', '-shm']) {
      rmSync(dbFile + ext, { force: true });
    }

    const hub1 = await startHub(dbFile, workDir);
    let agentSessionId = '';

    await withClient(hub1.baseUrl, async (client) => {
      const reg = parseToolJson(await callTool(client, 'hub_register', { agent_id: 'resumer' }));
      expect(reg.ok).toBe(true);
      agentSessionId = reg.session_id as string;
      hub1.store.enqueueMessage('resumer', { kind: 'work', n: 42 });

      const st = parseToolJson(await callTool(client, 'hub_status', {}));
      expect((st.pending_messages as unknown[]).length).toBe(1);
    });

    await hub1.close();

    const hub2 = await startHub(dbFile, workDir);

    await withClient(hub2.baseUrl, async (client) => {
      const reg = parseToolJson(await callTool(client, 'hub_register', { agent_id: 'resumer' }));
      expect(reg.ok).toBe(true);
      expect(reg.session_id).not.toBe(agentSessionId);

      const st = parseToolJson(await callTool(client, 'hub_status', {}));
      const pending = st.pending_messages as { id: string; payload: { kind: string; n: number } }[];
      expect(pending.length).toBe(1);
      expect(pending[0].payload.n).toBe(42);

      const mid = pending[0].id;
      const ping = parseToolJson(await callTool(client, 'hub_ping', { ack_message_ids: [mid] }));
      expect(ping.ok).toBe(true);
      expect(ping.acked).toBe(1);

      const st2 = parseToolJson(await callTool(client, 'hub_status', {}));
      expect((st2.pending_messages as unknown[]).length).toBe(0);
    });

    await hub2.close();
  });
});
