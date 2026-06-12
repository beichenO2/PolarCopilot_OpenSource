import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { BroadcastPublisher } from '../src/broadcast/publisher.js';
import { SseHub } from '../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../src/broadcast/subscriber.js';
import {
  CHECKUP_INBOX_TOPIC,
  fetchCheckupEnvelopes,
  loadCheckupEnvelopesFromHubDb,
} from '../src/checkup/route.js';
import { createHubDatabase } from '../src/persistence/db.js';
import { HubStore } from '../src/persistence/store.js';

const silentLogger = pino({ level: 'silent' });

function envelope(
  eventId: string,
  receivedAt: string,
  userText = 'test',
): { received_at: string; event: Record<string, unknown> } {
  return {
    received_at: receivedAt,
    event: {
      event_id: eventId,
      project: 'PolarCopilot',
      page_url: 'http://localhost/',
      user_text: userText,
      timestamp: receivedAt,
    },
  };
}

describe('fetchCheckupEnvelopes — jsonl + inbox merge', () => {
  let tmp: string;
  let jsonlPath: string;
  let sqlite: ReturnType<typeof createHubDatabase>['sqlite'];
  let db: ReturnType<typeof createHubDatabase>['db'];
  let prevJsonlEnv: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pc-fetch-checkup-'));
    jsonlPath = join(tmp, 'checkup-events.jsonl');
    prevJsonlEnv = process.env.PC_CHECKUP_JSONL_PATH;
    process.env.PC_CHECKUP_JSONL_PATH = jsonlPath;

    const created = createHubDatabase(join(tmp, 'hub.sqlite'));
    sqlite = created.sqlite;
    db = created.db;
  });

  afterEach(() => {
    if (prevJsonlEnv === undefined) delete process.env.PC_CHECKUP_JSONL_PATH;
    else process.env.PC_CHECKUP_JSONL_PATH = prevJsonlEnv;
    sqlite.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('merges distinct jsonl and inbox rows', async () => {
    writeFileSync(
      jsonlPath,
      `${JSON.stringify(envelope('aa0e8400-e29b-41d4-a716-446655440001', '2026-05-20T11:00:00Z', 'from-jsonl'))}\n`,
      'utf-8',
    );

    const store = new HubStore(db);
    const publisher = new BroadcastPublisher(store, new SseHub(), new EventSubscriber());
    publisher.publish({
      sourceAgentId: 'hub-checkup',
      topic: CHECKUP_INBOX_TOPIC,
      payload: {
        type: 'checkup_event',
        event: envelope('bb0e8400-e29b-41d4-a716-446655440002', '2026-05-20T12:00:00Z', 'from-inbox').event,
      },
      idempotencyKey: 'checkup:bb0e8400-e29b-41d4-a716-446655440002',
    });

    const rows = await fetchCheckupEnvelopes(
      { db, sotagentBase: 'http://127.0.0.1:9', forwardEnabled: false, logger: silentLogger },
      50,
    );

    const ids = rows.map((r) => String(r.event.event_id));
    expect(ids).toContain('aa0e8400-e29b-41d4-a716-446655440001');
    expect(ids).toContain('bb0e8400-e29b-41d4-a716-446655440002');
    expect(rows.find((r) => r.event.event_id === 'bb0e8400-e29b-41d4-a716-446655440002')?.event.user_text).toBe(
      'from-inbox',
    );
  });

  it('dedupes by event_id with inbox winning over jsonl', async () => {
    const sharedId = 'cc0e8400-e29b-41d4-a716-446655440003';
    writeFileSync(
      jsonlPath,
      `${JSON.stringify(envelope(sharedId, '2026-05-20T10:00:00Z', 'jsonl-copy'))}\n`,
      'utf-8',
    );

    const store = new HubStore(db);
    const publisher = new BroadcastPublisher(store, new SseHub(), new EventSubscriber());
    publisher.publish({
      sourceAgentId: 'hub-checkup',
      topic: CHECKUP_INBOX_TOPIC,
      payload: {
        type: 'checkup_event',
        event: envelope(sharedId, '2026-05-20T13:00:00Z', 'inbox-copy').event,
      },
      idempotencyKey: `checkup:${sharedId}`,
    });

    const rows = await fetchCheckupEnvelopes(
      { db, sotagentBase: 'http://127.0.0.1:9', forwardEnabled: false, logger: silentLogger },
      50,
    );

    const match = rows.filter((r) => r.event.event_id === sharedId);
    expect(match).toHaveLength(1);
    expect(match[0]?.event.user_text).toBe('inbox-copy');
  });

  it('sorts by received_at descending and applies limit', async () => {
    writeFileSync(
      jsonlPath,
      [
        JSON.stringify(envelope('dd0e8400-e29b-41d4-a716-446655440004', '2026-05-20T08:00:00Z')),
        JSON.stringify(envelope('ee0e8400-e29b-41d4-a716-446655440005', '2026-05-20T14:00:00Z')),
      ].join('\n') + '\n',
      'utf-8',
    );

    const rows = await fetchCheckupEnvelopes(
      { db, sotagentBase: 'http://127.0.0.1:9', forwardEnabled: false, logger: silentLogger },
      2,
    );

    expect(rows).toHaveLength(2);
    expect(String(rows[0]?.event.event_id)).toBe('ee0e8400-e29b-41d4-a716-446655440005');
    expect(String(rows[1]?.event.event_id)).toBe('dd0e8400-e29b-41d4-a716-446655440004');
  });
});

describe('loadCheckupEnvelopesFromHubDb', () => {
  it('reads inbox topic payloads from hub db', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pc-load-inbox-'));
    const { sqlite, db } = createHubDatabase(join(tmpDir, 'hub.sqlite'));
    const store = new HubStore(db);
    const publisher = new BroadcastPublisher(store, new SseHub(), new EventSubscriber());
    const ev = envelope('ff0e8400-e29b-41d4-a716-446655440006', '2026-05-20T09:00:00Z');
    publisher.publish({
      sourceAgentId: 'hub-checkup',
      topic: CHECKUP_INBOX_TOPIC,
      payload: { type: 'checkup_event', event: ev.event },
      idempotencyKey: 'checkup:ff0e8400-e29b-41d4-a716-446655440006',
    });

    const rows = loadCheckupEnvelopesFromHubDb(db, 10);
    expect(rows.some((r) => r.event.event_id === ev.event.event_id)).toBe(true);

    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
