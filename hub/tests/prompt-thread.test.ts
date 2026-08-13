import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubDatabase, uiPrompts, type HubDb } from '../src/persistence/db.js';
import { buildThread, mountPromptThread } from '../src/ui/prompt-thread.js';

interface TestHarness {
  baseUrl: string;
  db: HubDb;
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
  const tmp = mkdtempSync(join(tmpdir(), 'pc-hub-prompt-thread-'));
  const dbPath = join(tmp, 'hub.sqlite');
  const { sqlite, db } = createHubDatabase(dbPath);

  const app = express();
  mountPromptThread(app, db);

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

describe('GET /api/ui/prompts/thread', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await startHarness();
  });

  afterEach(async () => {
    await harness.shutdown();
  });

  it('returns messages in chronological order (createdAt ASC)', async () => {
    const agentId = 'agent-chrono';
    insertPrompt(harness.db, {
      id: 'p-first',
      prompt: 'First agent question',
      agentId,
      createdAt: new Date('2026-01-01T10:00:00.000Z'),
      answeredAt: new Date('2026-01-01T10:05:00.000Z'),
      answer: 'First answer',
    });
    insertPrompt(harness.db, {
      id: 'p-second',
      prompt: 'Second agent question',
      agentId,
      createdAt: new Date('2026-01-02T10:00:00.000Z'),
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread?agent_id=${agentId}`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      agent_id: string;
      messages: Array<{ id: string; role: string; text: string }>;
    };

    expect(body.agent_id).toBe(agentId);
    expect(body.messages.map((m) => m.id)).toEqual([
      'p-first:agent',
      'p-first:user',
      'p-second:agent',
      'p-second:pending',
    ]);
    expect(body.messages[0]?.text).toBe('First agent question');
    expect(body.messages[2]?.text).toBe('Second agent question');
  });

  it('emits user bubble when answered and pending when unanswered', async () => {
    const agentId = 'agent-roles';
    insertPrompt(harness.db, {
      id: 'answered-p',
      prompt: 'Pick one',
      options: ['A', 'B'],
      agentId,
      createdAt: new Date('2026-01-01T12:00:00.000Z'),
      answeredAt: new Date('2026-01-01T12:10:00.000Z'),
      answer: 'A',
    });
    insertPrompt(harness.db, {
      id: 'pending-p',
      prompt: 'Still waiting',
      options: ['X', 'Y'],
      agentId,
      createdAt: new Date('2026-01-02T12:00:00.000Z'),
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread?agent_id=${agentId}`);
    const body = (await resp.json()) as {
      messages: Array<{
        id: string;
        role: string;
        text: string;
        options?: string[];
        attachments: unknown[];
      }>;
    };

    const answeredUser = body.messages.find((m) => m.id === 'answered-p:user');
    expect(answeredUser).toMatchObject({ role: 'user', text: 'A', attachments: [] });
    expect(body.messages.some((m) => m.id === 'answered-p:pending')).toBe(false);

    const pending = body.messages.find((m) => m.id === 'pending-p:pending');
    expect(pending).toMatchObject({
      role: 'pending',
      text: '待你答',
      options: ['X', 'Y'],
      attachments: [],
    });
    expect(body.messages.some((m) => m.id === 'pending-p:user')).toBe(false);
  });

  it('returns 400 when agent_id is missing', async () => {
    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread`);
    expect(resp.status).toBe(400);
  });

  it('extracts html, image, and pdf attachments from agent prompt text', async () => {
    const agentId = 'agent-attach';
    const prompt =
      'See /design/mock.html and /assets/logo.png plus https://cdn.example.com/spec.pdf and /data/export.csv';
    insertPrompt(harness.db, {
      id: 'attach-p',
      prompt,
      agentId,
      createdAt: new Date('2026-01-03T08:00:00.000Z'),
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread?agent_id=${agentId}`);
    const body = (await resp.json()) as {
      messages: Array<{ role: string; attachments: Array<{ kind: string; href: string }> }>;
    };

    const agentMsg = body.messages.find((m) => m.role === 'agent');
    expect(agentMsg?.attachments).toEqual(
      expect.arrayContaining([
        { kind: 'html', href: '/design/mock.html' },
        { kind: 'image', href: '/assets/logo.png' },
        { kind: 'pdf', href: 'https://cdn.example.com/spec.pdf' },
        { kind: 'file', href: '/data/export.csv' },
      ]),
    );
    expect(agentMsg?.attachments).toHaveLength(4);

    const pendingMsg = body.messages.find((m) => m.role === 'pending');
    expect(pendingMsg?.attachments).toEqual([]);
  });

  it('only includes prompts for the requested agent', async () => {
    insertPrompt(harness.db, {
      id: 'mine',
      prompt: 'Mine',
      agentId: 'agent-a',
      createdAt: new Date('2026-01-01T09:00:00.000Z'),
    });
    insertPrompt(harness.db, {
      id: 'theirs',
      prompt: 'Theirs',
      agentId: 'agent-b',
      createdAt: new Date('2026-01-01T09:00:00.000Z'),
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread?agent_id=agent-a`);
    const body = (await resp.json()) as { messages: Array<{ prompt_id: string }> };

    expect(body.messages.every((m) => m.prompt_id === 'mine')).toBe(true);
    expect(body.messages.some((m) => m.prompt_id === 'theirs')).toBe(false);
  });
});

describe('buildThread', () => {
  it('uses ISO 8601 created_at timestamps', () => {
    const created = new Date('2026-03-15T14:30:00.123Z');
    const answered = new Date('2026-03-15T14:35:00.456Z');
    const thread = buildThread('agent-iso', [
      {
        id: 'iso-p',
        prompt: 'Question?',
        optionsJson: '["ok"]',
        answer: 'ok',
        agentId: 'agent-iso',
        createdAt: created,
        answeredAt: answered,
      },
    ]);

    expect(thread.messages[0]?.created_at).toBe('2026-03-15T14:30:00.123Z');
    expect(thread.messages[1]?.created_at).toBe('2026-03-15T14:35:00.456Z');
  });
});
