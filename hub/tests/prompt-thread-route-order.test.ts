/**
 * WHY: Express param `:id` swallows `/thread` if registered first.
 * mountP2Surface / mountPromptThread must run before GET /api/ui/prompts/:id.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createHubDatabase, type HubDb } from '../src/persistence/db.js';
import { mountPromptThread } from '../src/ui/prompt-thread.js';
import { mountP2Surface } from '../src/ui/p2-surface-mount.js';

interface TestHarness {
  baseUrl: string;
  db: HubDb;
  shutdown: () => Promise<void>;
}

async function startHarness(setup: (app: express.Express, db: HubDb) => void): Promise<TestHarness> {
  const tmp = mkdtempSync(join(tmpdir(), 'pc-hub-prompt-thread-order-'));
  const dbPath = join(tmp, 'hub.sqlite');
  const { sqlite, db } = createHubDatabase(dbPath);

  const app = express();
  setup(app, db);

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

describe('prompt thread route registration order', () => {
  let harness: TestHarness;

  afterEach(async () => {
    if (harness) {
      await harness.shutdown();
    }
  });

  it('shadow (wrong order): :id before thread swallows /thread as id=thread → 404', async () => {
    harness = await startHarness((app, db) => {
      app.get('/api/ui/prompts/:id', (_req, res) => {
        res.status(404).json({ error: 'not_found' });
      });
      mountPromptThread(app, db);
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread`);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: 'not_found' });
  });

  it('correct order: mountPromptThread before :id → 400 agent_id required, not 404', async () => {
    harness = await startHarness((app, db) => {
      mountPromptThread(app, db);
      app.get('/api/ui/prompts/:id', (_req, res) => {
        res.status(404).json({ error: 'not_found' });
      });
    });

    const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread`);
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({ error: 'agent_id required' });
  });

  it('correct order: mountP2Surface before :id → 400 agent_id required, not 404', async () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'pc-hub-p2-mirror-'));
    try {
      harness = await startHarness((app, db) => {
        mountP2Surface(app, { hubDb: db, mirrorRoot });
        app.get('/api/ui/prompts/:id', (_req, res) => {
          res.status(404).json({ error: 'not_found' });
        });
      });

      const resp = await fetch(`${harness.baseUrl}/api/ui/prompts/thread`);
      expect(resp.status).toBe(400);
      expect(await resp.json()).toEqual({ error: 'agent_id required' });
    } finally {
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });
});
