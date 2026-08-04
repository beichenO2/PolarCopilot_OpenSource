import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { initTaskArtifacts, writeState, readSummary } from '../../src/rr/afk/index.js';
import { createRrRouter } from '../../src/rr/router.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('rr afk human review api', () => {
  const roots: string[] = [];
  const servers: Server[] = [];
  const envBackup = { ...process.env };

  afterEach(async () => {
    process.env = { ...envBackup };
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  async function startServer() {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-route-'));
    roots.push(root);
    const afkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-route-data-'));
    roots.push(afkRoot);
    process.env.RR_AFK_ROOT = afkRoot;

    initTaskArtifacts({
      taskId: 'knowlever-solo',
      projectRoot: root,
      masterSessionId: 'sess-1',
    });
    writeState('knowlever-solo', {
      ...readSummary('knowlever-solo')!,
      status: 'NEEDS_HUMAN',
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U11',
        plan_revision: 16,
        paths: ['tests/discovery.test.ts'],
      },
      master_session_id: 'sess-1',
      project_root: root,
      current_unit: 'U11',
      plan_revision: 16,
      loop: 0,
      max_loops: 40,
      allowlist: [],
      last_command: null,
      last_verification: null,
      human_action_hint: 'review',
      updated_at: new Date().toISOString(),
    });

    const store = new RrFileStore(join(root, 'chat'));
    const app = express();
    app.use(express.json());
    app.use('/api', createRrRouter({ store }));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid_test_server_address');
    return `http://127.0.0.1:${address.port}/api/ui/rr/afk/knowlever-solo/grant-temporary-paths`;
  }

  it('returns 410 for removed codex-afk grant route', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-codex-gone-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'));
    const app = express();
    app.use(express.json());
    app.use('/api', createRrRouter({ store }));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid_test_server_address');
    const url = `http://127.0.0.1:${address.port}/api/ui/rr/codex-afk/knowlever-solo/grant-temporary-paths`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['tests/discovery.test.ts'], confirmed: true }),
    });

    expect(response.status).toBe(410);
  });

  it('requires explicit human confirmation before granting temporary paths', async () => {
    const url = await startServer();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['tests/discovery.test.ts'], confirmed: false }),
    });

    expect(response.status).toBe(400);
  });

  it('grants the reviewed path set via rr ssot and returns resumed state', async () => {
    const url = await startServer();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: ['tests/discovery.test.ts'], confirmed: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: 'READY',
      usesRemaining: 1,
      grantedPaths: ['tests/discovery.test.ts'],
    });
    expect(readSummary('knowlever-solo')?.allowlist).toEqual(['tests/discovery.test.ts']);
  });
});
