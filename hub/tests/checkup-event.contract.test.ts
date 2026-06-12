import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { BroadcastPublisher } from '../src/broadcast/publisher.js';
import { SseHub } from '../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../src/broadcast/subscriber.js';
import { createHubDatabase, sessions } from '../src/persistence/db.js';
import { HubStore } from '../src/persistence/store.js';
import {
  createCheckupRouter,
  mergeCheckupReportStatus,
  parseReportAlert,
  indexReportsFromAlerts,
} from '../src/checkup/route.js';
import { pushAlert } from '../src/alerts/router.js';

const silentLogger = pino({ level: 'silent' });

interface TestHarness {
  baseUrl: string;
  shutdown: () => Promise<void>;
  db: ReturnType<typeof createHubDatabase>['db'];
}

async function startHarness(): Promise<TestHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'pc-hub-checkup-'));
  const dbPath = join(tmp, 'hub.sqlite');
  const { sqlite, db } = createHubDatabase(dbPath);
  const store = new HubStore(db);
  const sseHub = new SseHub();
  const subscriber = new EventSubscriber();
  const publisher = new BroadcastPublisher(store, sseHub, subscriber);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(
    '/api',
    createCheckupRouter({
      db,
      publisher,
      logger: silentLogger,
      disableSotagentForward: true,
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    db,
    shutdown: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          sqlite.close();
          rmSync(tmp, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

function makeValidEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: '550e8400-e29b-41d4-a716-446655440000',
    project: 'KnowLever',
    agent_target: '@checkup-agent',
    page_url: 'http://localhost:3001/dashboard',
    page_title: 'KnowLever Dashboard',
    user_text: 'Button is misaligned on hover',
    timestamp: '2026-05-08T04:50:00Z',
    ...overrides,
  };
}

describe('POST /api/checkup-event — schema validation', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('returns 200 + event_id for a valid payload', async () => {
    const ev = makeValidEvent();
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; event_id: string; routed_to_inbox: boolean };
    expect(body.ok).toBe(true);
    expect(body.event_id).toBe(ev.event_id);
    expect(body.routed_to_inbox).toBe(true);
  });

  it('returns 400 for missing required field (no event_id)', async () => {
    const ev = makeValidEvent();
    delete (ev as Record<string, unknown>).event_id;
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string; errors: unknown[] };
    expect(body.error).toBe('invalid_payload');
    expect(Array.isArray(body.errors)).toBe(true);
  });

  it('returns 400 for invalid uuid in event_id', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ event_id: 'not-a-uuid' })),
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 for invalid timestamp format', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ timestamp: 'yesterday' })),
    });
    expect(r.status).toBe(400);
  });

  it('returns 400 for additional unknown property (additionalProperties: false)', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ unknown_field: 'reject me' })),
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/checkup-event — agent routing', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('returns 400 when agent_target is not @checkup-agent (schema)', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ agent_target: 'no-such-agent' })),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_payload');
  });

  it('accepts @checkup-agent without a live Hub session', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent()),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { routed_to_inbox: boolean };
    expect(body.routed_to_inbox).toBe(true);
  });

});

describe('POST /api/checkup-event — robustness (attack surface)', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('rejects empty body', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(400);
  });

  it('rejects non-object body (string)', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '"hello"',
    });
    expect(r.status).toBe(400);
  });

  it('rejects array body', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    });
    expect(r.status).toBe(400);
  });

  it('rejects type-confused fields (number where string expected)', async () => {
    const r = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeValidEvent({ project: 12345 })),
    });
    expect(r.status).toBe(400);
  });

  it('handles concurrent valid posts without crashing (50x)', async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      fetch(`${harness.baseUrl}/api/checkup-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makeValidEvent({
            event_id: `${'a'.repeat(8)}-${'b'.repeat(4)}-4${'c'.repeat(3)}-9${'d'.repeat(3)}-${i.toString().padStart(12, '0')}`,
            agent_target: '@checkup-agent',
          }),
        ),
      }),
    );
    const results = await Promise.all(promises);
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBe(50);
  });
});

describe('GET /api/ui/checkup-events', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('returns ok envelope with stats and events array', async () => {
    const r = await fetch(`${harness.baseUrl}/api/ui/checkup-events?limit=10`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      count: number;
      stats: Record<string, number>;
      events: unknown[];
    };
    expect(body.ok).toBe(true);
    expect(typeof body.count).toBe('number');
    expect(body.stats).toMatchObject({
      pending: expect.any(Number),
      processing: expect.any(Number),
      resolved: expect.any(Number),
      needs_human: expect.any(Number),
    });
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('lists a posted event after POST → GET round trip', async () => {
    const ev = makeValidEvent({
      event_id: 'aa0e8400-e29b-41d4-a716-446655440099',
      user_text: 'round7 roundtrip',
    });
    const post = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(post.status).toBe(200);

    const list = await fetch(`${harness.baseUrl}/api/ui/checkup-events?limit=20`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { events: Array<{ event_id: string; user_text: string }> };
    const row = body.events.find((e) => e.event_id === ev.event_id);
    expect(row?.user_text).toBe('round7 roundtrip');
  });

  it('Hub-side enqueue daemon marks freshly POSTed events as processing', async () => {
    const ev = makeValidEvent({
      event_id: 'aa0e8400-e29b-41d4-a716-446655440200',
      user_text: 'enqueue daemon smoke',
    });
    const post = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(post.status).toBe(200);

    const list = await fetch(`${harness.baseUrl}/api/ui/checkup-events?limit=50`);
    const body = (await list.json()) as {
      events: Array<{ event_id: string; status: string; summary?: string; handler?: string }>;
    };
    const row = body.events.find((e) => e.event_id === ev.event_id);
    expect(row?.status).toBe('processing');
    expect(row?.handler).toBe('hub-checkup-watcher');
    expect(row?.summary).toContain('已入队');
  });
});

describe('checkup history page smoke (UI redirect + SPA)', () => {
  const pcWebDist = join(process.env.HOME ?? '', 'Polarisor', 'PolarCopilot', 'web', 'dist');
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.get('/ui/checkup-events', (_req, res) => {
      res.redirect(301, '/pc/checkup-events');
    });
    if (existsSync(pcWebDist)) {
      app.use('/pc', express.static(pcWebDist, { etag: false, lastModified: false, maxAge: 0 }));
      app.get(/^\/pc\/.*/, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(join(pcWebDist, 'index.html'));
      });
    }
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /ui/checkup-events → 301 Location /pc/checkup-events', async () => {
    const r = await fetch(`${baseUrl}/ui/checkup-events`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/pc/checkup-events');
  });

  it.skipIf(!existsSync(pcWebDist))('GET /pc/checkup-events → 200 HTML', async () => {
    const r = await fetch(`${baseUrl}/pc/checkup-events`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.toLowerCase()).toContain('<!doctype html');
  });
});

describe('P2-R3 — human approval alert + dual-path status merge', () => {
  it('parseReportAlert extracts event_id from checkup_human_approval', () => {
    const parsed = parseReportAlert(
      JSON.stringify({
        type: 'checkup_human_approval',
        event_id: '770e8400-e29b-41d4-a716-446655440001',
        reason: '置信度不足',
      }),
    );
    expect(parsed?.event_id).toBe('770e8400-e29b-41d4-a716-446655440001');
    expect(parsed?.status).toBe('needs_human');
    expect(parsed?.summary).toBe('置信度不足');
  });

  it('mergeCheckupReportStatus prefers needs_human over resolved', () => {
    expect(mergeCheckupReportStatus('resolved', 'needs_human')).toBe('needs_human');
    expect(mergeCheckupReportStatus('resolved', undefined, { approved: false })).toBe('needs_human');
    expect(mergeCheckupReportStatus('resolved', undefined, { shellOk: true })).toBe('resolved');
  });

  it('indexReportsFromAlerts merges fix and human alerts for same event', () => {
    const eventId = '880e8400-e29b-41d4-a716-446655440002';
    const alerts = [
      {
        source: 'polarui-output-display',
        title: '检修：需人工介入',
        detail: JSON.stringify({
          type: 'checkup_human_approval',
          event_id: eventId,
          reason: '需人工审批',
        }),
      },
      {
        source: 'polarui-output-display',
        title: '检修处理结果',
        detail: JSON.stringify({
          event_id: eventId,
          status: 'resolved',
          summary: '自动修复完成',
        }),
      },
    ];
    const map = indexReportsFromAlerts(alerts);
    expect(map.get(eventId)?.status).toBe('needs_human');
    expect(map.get(eventId)?.summary).toBe('自动修复完成');
  });
});

describe('GET /api/ui/checkup-events — human intervention alert', () => {
  let harness: TestHarness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => harness.shutdown());

  it('shows needs_human when HumanApproval alert is posted for event', async () => {
    const eventId = '990e8400-e29b-41d4-a716-446655440003';
    const ev = makeValidEvent({
      event_id: eventId,
      user_text: 'human path event',
    });
    const post = await fetch(`${harness.baseUrl}/api/checkup-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ev),
    });
    expect(post.status).toBe(200);

    pushAlert({
      source: 'polarui-output-display',
      severity: 'info',
      title: '检修：需人工介入',
      detail: JSON.stringify({
        type: 'checkup_human_approval',
        event_id: eventId,
        reason: '自动修复置信度不足',
      }),
      timestamp: new Date().toISOString(),
    });

    const list = await fetch(`${harness.baseUrl}/api/ui/checkup-events?limit=20`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      events: Array<{ event_id: string; status: string; summary?: string }>;
      stats: { needs_human: number };
    };
    const row = body.events.find((e) => e.event_id === eventId);
    expect(row?.status).toBe('needs_human');
    expect(row?.summary).toBe('自动修复置信度不足');
    expect(body.stats.needs_human).toBeGreaterThanOrEqual(1);
  });
});
