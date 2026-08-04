import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedSubagentCount, createRrRouter } from '../../src/rr/router.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('rr orchestrator config api', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('blocks future subagent slots without blocking the main process slot', () => {
    expect(allowedSubagentCount(2, false)).toBe(0);
    expect(allowedSubagentCount(2, true)).toBe(2);
  });

  it('reads and updates only the future subagent creation policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-config-api-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const store = new RrFileStore(join(root, 'chat'));
    const app = express();
    app.use(express.json());
    app.use('/api', createRrRouter({ store, orchestratorConfigPath: configPath }));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid_test_server_address');
    const base = `http://127.0.0.1:${address.port}/api/ui/rr/config`;

    const initial = await fetch(base);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ allowNewSubagents: true });

    const updated = await fetch(base, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowNewSubagents: false }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ allowNewSubagents: false });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).allowNewSubagents).toBe(false);
  });
});
