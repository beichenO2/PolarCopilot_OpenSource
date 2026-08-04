import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRrRouter } from '../../src/rr/router.js';
import { globalConfigPath } from '../../src/rr/orchestrator/config.js';
import * as polarService from '../../src/rr/orchestrator/polar-service.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('rr afk mode e2e smoke (L1 HTTP)', () => {
  const roots: string[] = [];
  const servers: Server[] = [];
  const envBackup = { ...process.env };

  beforeEach(() => {
    vi.spyOn(polarService, 'readOrchestratorServiceState').mockResolvedValue({
      enabled: true,
      running: true,
      serviceStatus: 'running',
      pid: 1,
    });
    vi.spyOn(polarService, 'startOrchestratorService').mockResolvedValue({
      enabled: true,
      polarprocess: null,
      running: true,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...envBackup };
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  async function startServer() {
    const root = mkdtempSync(join(tmpdir(), 'rr-afk-mode-e2e-'));
    roots.push(root);
    const afkRoot = mkdtempSync(join(tmpdir(), 'rr-afk-mode-e2e-data-'));
    roots.push(afkRoot);
    const projectRoot = mkdtempSync(join(tmpdir(), 'rr-afk-mode-e2e-proj-'));
    roots.push(projectRoot);

    process.env.RR_AFK_ROOT = afkRoot;
    process.env.PC_PROJECT_DIR = projectRoot;

    const fakeHome = mkdtempSync(join(tmpdir(), 'rr-afk-mode-e2e-home-'));
    roots.push(fakeHome);
    process.env.HOME = fakeHome;

    const configPath = globalConfigPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({
      allowNewSubagents: true,
      autoDispatchSubagents: true,
      projectRoot,
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(projectRoot, '.rr-orchestrator.json'), `${JSON.stringify({
      projectRoot,
      afkRoot: join(projectRoot, 'legacy-afk'),
      statePath: join(projectRoot, 'state.json'),
    }, null, 2)}\n`, 'utf8');

    const store = new RrFileStore(join(root, 'chat'));
    const app = express();
    app.use(express.json());
    app.use('/api', createRrRouter({ store, orchestratorConfigPath: configPath }));
    const server = createServer(app);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('invalid_test_server_address');

    const base = `http://127.0.0.1:${address.port}/api/ui/rr`;
    return { base, store, projectRoot, configPath };
  }

  async function registerMaster(base: string, name = 'E2E Master') {
    const response = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { session: { sessionId: string } };
    return body.session.sessionId;
  }

  it('rejects invalid mode via HTTP one-click (C3)', async () => {
    const { base } = await startServer();
    const response = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'bogus', spawnIfNeeded: false }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain('invalid_afk_mode');
  });

  it('mode=go sets task allow_new_subagents=false without global OFF; inject forbids dispatch (C4/P4-C5)', async () => {
    const { base, projectRoot, configPath } = await startServer();
    const sessionId = await registerMaster(base, 'Go Master');

    const oneClick = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        mode: 'go',
        taskSlug: 'e2e-go-task',
        projectRoot,
        spawnIfNeeded: false,
        startOrchestrator: false,
        force: true,
      }),
    });
    expect(oneClick.status).toBe(201);
    const clickBody = await oneClick.json() as {
      sessionId: string;
      status: { summaries: Array<{ task_id: string; mode?: string; allow_new_subagents?: boolean }> };
    };
    expect(clickBody.sessionId).toBe(sessionId);
    const goSummary = clickBody.status.summaries.find((item) => item.task_id === 'e2e-go-task');
    expect(goSummary?.mode).toBe('go');
    expect(goSummary?.allow_new_subagents).toBe(false);

    // Phase-4: go must not stomp the global panel toggle.
    const config = await fetch(`${base}/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ allowNewSubagents: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).allowNewSubagents).toBe(true);

    const history = await fetch(`${base}/sessions/${sessionId}`);
    expect(history.status).toBe(200);
    const historyBody = await history.json() as { history: Array<{ content: string }> };
    const inject = historyBody.history.find((msg) => msg.content.includes('【Rr AFK · 首条注入】'));
    expect(inject?.content).toContain('Mode=go');
    expect(inject?.content).toContain('禁止 list_subagents / dispatch_subagent_task');

    const status = await fetch(`${base}/afk/status?projectRoot=${encodeURIComponent(projectRoot)}`);
    expect(status.status).toBe(200);
    const statusBody = await status.json() as {
      active: boolean;
      summaries: Array<{ task_id: string; mode?: string; allow_new_subagents?: boolean }>;
    };
    expect(typeof statusBody.active).toBe('boolean');
    expect(statusBody.summaries.some((item) => item.task_id === 'e2e-go-task' && item.mode === 'go')).toBe(true);
    expect(statusBody.summaries.find((item) => item.task_id === 'e2e-go-task')?.allow_new_subagents).toBe(false);

    // Hard reject HTTP dispatch for go masters (P4-C3).
    const child = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Go Child' }),
    });
    const childBody = await child.json() as { session: { sessionId: string } };
    await fetch(`${base}/sessions/${childBody.session.sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isSubagent: true }),
    });
    const dispatch = await fetch(`${base}/sessions/${sessionId}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetSessionId: childBody.session.sessionId,
        content: 'should be forbidden',
      }),
    });
    expect(dispatch.status).toBe(403);
    const dispatchBody = await dispatch.json() as { ok: boolean; error: string };
    expect(dispatchBody.error).toContain('afk_mode_go_forbids_dispatch');
  });

  it('mode=solo does not force allowNewSubagents OFF (C5)', async () => {
    const { base, projectRoot, configPath } = await startServer();
    const sessionId = await registerMaster(base, 'Solo Master');

    const oneClick = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        mode: 'solo',
        taskSlug: 'e2e-solo-task',
        projectRoot,
        spawnIfNeeded: false,
        startOrchestrator: false,
        force: true,
      }),
    });
    expect(oneClick.status).toBe(201);
    const clickBody = await oneClick.json() as {
      status: { summaries: Array<{ task_id: string; mode?: string }> };
    };
    expect(clickBody.status.summaries.find((item) => item.task_id === 'e2e-solo-task')?.mode).toBe('solo');

    const config = await fetch(`${base}/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ allowNewSubagents: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).allowNewSubagents).toBe(true);
  });

  it('mode=start does not force allowNewSubagents OFF (C5)', async () => {
    const { base, projectRoot, configPath } = await startServer();
    const sessionId = await registerMaster(base, 'Start Master');

    const oneClick = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        mode: 'start',
        taskSlug: 'e2e-start-task',
        projectRoot,
        spawnIfNeeded: false,
        startOrchestrator: false,
        force: true,
      }),
    });
    expect(oneClick.status).toBe(201);
    const clickBody = await oneClick.json() as {
      status: { summaries: Array<{ task_id: string; mode?: string }> };
    };
    expect(clickBody.status.summaries.find((item) => item.task_id === 'e2e-start-task')?.mode).toBe('start');

    const config = await fetch(`${base}/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({ allowNewSubagents: true });
    expect(JSON.parse(readFileSync(configPath, 'utf8')).allowNewSubagents).toBe(true);
  });

  it('returns no_master_session when spawnIfNeeded=false and no master (C6 process-level)', async () => {
    const { base, projectRoot } = await startServer();
    const response = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'solo',
        taskSlug: 'e2e-no-master',
        projectRoot,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }),
    });

    expect(response.status).toBe(409);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no_master_session');
  });

  it('does not fall back to another master when sessionId misses and spawnIfNeeded=false (C6)', async () => {
    const { base, projectRoot } = await startServer();
    await registerMaster(base, 'Other Master');

    const response = await fetch(`${base}/afk/one-click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'solo',
        sessionId: '__smoke_nonexistent_session__',
        taskSlug: 'e2e-miss-session',
        projectRoot,
        spawnIfNeeded: false,
        startOrchestrator: false,
      }),
    });

    expect(response.status).toBe(409);
    const body = await response.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('no_master_session');

    const status = await fetch(`${base}/afk/status?projectRoot=${encodeURIComponent(projectRoot)}`);
    const statusBody = await status.json() as { summaries: Array<{ task_id: string }> };
    expect(statusBody.summaries.some((item) => item.task_id === 'e2e-miss-session')).toBe(false);
  });
});
