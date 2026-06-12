import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import Ajv from 'ajv';
import { BroadcastPublisher } from '../src/broadcast/publisher.js';
import { SseHub } from '../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../src/broadcast/subscriber.js';
import { createHubDatabase } from '../src/persistence/db.js';
import { HubStore } from '../src/persistence/store.js';
import { createLobsterRouter } from '../src/lobster/router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const silentLogger = pino({ level: 'silent' });

const SCHEMA_PATH = join(__dirname, '..', 'contracts', 'lobster-event.schema.json');
const EXAMPLE_PATH = join(__dirname, '..', 'contracts', 'examples', 'lobster-event.example.json');

interface TestHarness {
  baseUrl: string;
  publishedEvents: Array<{ topic: string; payload: unknown }>;
  shutdown: () => Promise<void>;
}

function startHarness(): Promise<TestHarness> {
  return new Promise((resolve, reject) => {
    const tmp = mkdtempSync(join(tmpdir(), 'pc-hub-lobster-'));
    const dbPath = join(tmp, 'hub.sqlite');
    const { sqlite, db } = createHubDatabase(dbPath);
    const store = new HubStore(db);
    const sseHub = new SseHub();
    const subscriber = new EventSubscriber();
    const publisher = new BroadcastPublisher(store, sseHub, subscriber);

    const publishedEvents: Array<{ topic: string; payload: unknown }> = [];

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(
      '/api',
      createLobsterRouter({
        publisher,
        logger: silentLogger,
        schemaPath: SCHEMA_PATH,
      }),
    );

    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        publishedEvents,
        shutdown: () =>
          new Promise<void>((res) => {
            server.close(() => {
              sqlite.close();
              rmSync(tmp, { recursive: true, force: true });
              res();
            });
          }),
      });
    });
  });
}

function makeValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    source: 'SOTAgent',
    target: 'KnowLever',
    type: 'command' as const,
    payload: { action: 'rebuild_topic', topic: 'pharm-test' },
    timestamp: '2026-05-09T10:30:00.000Z',
    target_agent_id: 'kl-agent-1',
    ...overrides,
  };
}

describe('lobster-event schema + example', () => {
  it('example validates against lobster-event.schema.json', () => {
    const ajv = new Ajv({ strict: false });
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf-8'));
    const validate = ajv.compile(schema);
    expect(validate(example)).toBe(true);
  });
});

describe('POST /api/lobster/events — valid events', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('returns 200 + event_id + topic for a valid event', async () => {
    const ev = makeValidEvent();
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; event_id: string; topic: string };
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(ev.id);
    expect(body.topic).toBe('kl-agent-1.inbox');
  });

  it('routes to target_topic when explicitly set', async () => {
    const ev = makeValidEvent({ target_topic: 'custom-channel' });
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { topic: string };
    expect(body.topic).toBe('custom-channel');
  });

  it('falls back to target as agent_id when target_agent_id not set', async () => {
    const ev = makeValidEvent();
    delete (ev as Record<string, unknown>).target_agent_id;
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { topic: string };
    expect(body.topic).toBe('KnowLever.inbox');
  });
});

describe('POST /api/lobster/events — validation errors', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('returns 400 for missing required fields (no id)', async () => {
    const ev = makeValidEvent();
    delete (ev as Record<string, unknown>).id;
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('returns 400 for invalid type enum value', async () => {
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ type: 'invalid_type' })),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('returns 400 for path traversal in target_agent_id', async () => {
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ target_agent_id: '../etc/passwd' })),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_target');
  });

  it('returns 400 for path traversal with .. in target', async () => {
    const ev = makeValidEvent();
    delete (ev as Record<string, unknown>).target_agent_id;
    const r = await fetch(`${harness.baseUrl}/api/lobster/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...ev, target: '../../secret' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/lobster/events — robustness', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('handles concurrent valid posts (100x)', async () => {
    const promises = Array.from({ length: 100 }, (_, i) =>
      fetch(`${harness.baseUrl}/api/lobster/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeValidEvent({
            id: `${'a'.repeat(8)}-${'b'.repeat(4)}-4${'c'.repeat(3)}-9${'d'.repeat(3)}-${i.toString().padStart(12, '0')}`,
          }),
        ),
      }),
    );
    const results = await Promise.all(promises);
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBe(100);
  });
});
