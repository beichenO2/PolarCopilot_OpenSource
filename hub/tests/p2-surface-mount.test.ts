import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubDatabase, uiPrompts, type HubDb } from '../src/persistence/db.js';
import { mountP2Surface } from '../src/ui/p2-surface-mount.js';

interface TestHarness {
  baseUrl: string;
  db: HubDb;
  mirrorRoot: string;
  shutdown: () => Promise<void>;
}

function insertPrompt(
  db: HubDb,
  row: {
    id: string;
    prompt: string;
    options?: string[];
    answer?: string | null;
    agentId: string;
    createdAt: Date;
    answeredAt?: Date | null;
  },
): void {
  db.insert(uiPrompts)
    .values({
      id: row.id,
      prompt: row.prompt,
      optionsJson: JSON.stringify(row.options ?? ['Yes', 'No']),
      answer: row.answer ?? null,
      agentId: row.agentId,
      createdAt: row.createdAt,
      answeredAt: row.answeredAt ?? null,
    })
    .run();
}

async function startHarness(): Promise<TestHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'pc-hub-p2-surface-'));
  const dbPath = join(tmp, 'hub.sqlite');
  const mirrorRoot = join(tmp, 'mirror');
  const { sqlite, db } = createHubDatabase(dbPath);

  const app = express();
  mountP2Surface(app, { hubDb: db, mirrorRoot });

  const server: Server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('no listen address');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    db,
    mirrorRoot,
    shutdown: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          try {
            sqlite.close();
          } catch {
            /* ignore */
          }
          rmSync(tmp, { recursive: true, force: true });
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

describe('mountP2Surface', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('returns 400 when agent_id is missing on GET thread', async () => {
    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread`);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'agent_id required' });
  });

  it('returns agent bubble and pending text 待你答 after inserting uiPrompt', async () => {
    const agentId = 'agent-p2';
    insertPrompt(harness.db, {
      id: 'p-pending',
      prompt: 'Choose wisely',
      options: ['A', 'B'],
      agentId,
      createdAt: new Date('2026-01-02T12:00:00.000Z'),
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread?agent_id=${agentId}`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      messages: Array<{ id: string; role: string; text: string }>;
    };

    const agent = body.messages.find((m) => m.id === 'p-pending:agent');
    expect(agent).toMatchObject({ role: 'agent', text: 'Choose wisely' });

    const pending = body.messages.find((m) => m.id === 'p-pending:pending');
    expect(pending).toMatchObject({ role: 'pending', text: '待你答' });
  });

  it('PUT _design html then GET returns raw text/html', async () => {
    const topicId = '_design';
    const html = '<!doctype html><html><body>design gate</body></html>';

    const putResp = await fetch(`${harness.baseUrl}/api/ui/topics/${topicId}/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    expect(putResp.status).toBe(200);

    const getResp = await fetch(`${harness.baseUrl}/api/ui/topics/${topicId}/html`);
    expect(getResp.status).toBe(200);
    expect(getResp.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await getResp.text()).toBe(html);
  });

  it('PUT with non-index filename returns 409 topic_overwrite', async () => {
    const resp = await fetch(`${harness.baseUrl}/api/ui/topics/_design/html`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<html>v2</html>', filename: 'v2.html' }),
    });
    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: 'topic_overwrite' });
  });
});
