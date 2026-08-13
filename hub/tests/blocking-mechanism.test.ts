import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

type RunningHub = { baseUrl: string; close: () => Promise<void> };

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
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error('no listen address'));
      }
    });
    server.on('error', reject);
  });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        try { sqlite.close(); } catch { /* ignore */ }
        if (err) reject(err);
        else resolve();
      });
    });

  return { baseUrl, close };
}

describe('Hub Web Blocking Mechanism', () => {
  let workDir: string;
  let hub: RunningHub;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'blocking-test-'));
    hub = await startHub(join(workDir, 'blocking.sqlite'), workDir);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('should block agent when sending prompt', async () => {
    // Register agent
    const regResp = await fetch(`${hub.baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'polarclaw',
        agent_name: 'TestAgent',
        main_model: 'qwen-3.6-plus',
        subagent_model: 'qwen-3.6-plus',
        capabilities: ['chat'],
      }),
    });
    const regData = await regResp.json() as { agent_id: string };
    const agentId = regData.agent_id;

    // Send prompt
    const promptResp = await fetch(`${hub.baseUrl}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: 'Choose an option',
        options: ['A', 'B', 'C'],
      }),
    });
    expect(promptResp.ok).toBe(true);
    const promptData = await promptResp.json() as { id: string };
    const promptId = promptData.id;

    // Check agent status is blocked
    const statusResp = await fetch(`${hub.baseUrl}/api/agents/${agentId}/status`);
    const statusData = await statusResp.json() as {
      status: string;
      current_prompt_id: string | null;
      blocked_for_ms: number | null;
    };
    expect(statusData.status).toBe('blocked');
    expect(statusData.current_prompt_id).toBe(promptId);
    expect(statusData.blocked_for_ms).toBeGreaterThanOrEqual(0);

    await hub.close();
  });

  it('should unblock agent after answer', async () => {
    const hub2 = await startHub(join(workDir, 'unblock.sqlite'), workDir);

    // Register agent
    const regResp = await fetch(`${hub2.baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'polarclaw',
        agent_name: 'TestAgent2',
        main_model: 'qwen-3.6-plus',
        subagent_model: 'qwen-3.6-plus',
        capabilities: ['chat'],
      }),
    });
    const regData = await regResp.json() as { agent_id: string };
    const agentId = regData.agent_id;

    // Send prompt
    const promptResp = await fetch(`${hub2.baseUrl}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: 'Choose',
        options: ['X', 'Y'],
      }),
    });
    const promptData = await promptResp.json() as { id: string };
    const promptId = promptData.id;

    // Answer the prompt
    const answerResp = await fetch(`${hub2.baseUrl}/api/ui/prompts/${promptId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer: 'X' }),
    });
    expect(answerResp.ok).toBe(true);

    // Check agent status is active
    const statusResp = await fetch(`${hub2.baseUrl}/api/agents/${agentId}/status`);
    const statusData = await statusResp.json() as {
      status: string;
      current_prompt_id: string | null;
    };
    expect(statusData.status).toBe('active');
    expect(statusData.current_prompt_id).toBeNull();

    await hub2.close();
  });

  it('should prevent second prompt while blocked', async () => {
    const hub3 = await startHub(join(workDir, 'prevent.sqlite'), workDir);

    // Register agent
    const regResp = await fetch(`${hub3.baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_type: 'polarclaw',
        agent_name: 'TestAgent3',
        main_model: 'qwen-3.6-plus',
        subagent_model: 'qwen-3.6-plus',
        capabilities: ['chat'],
      }),
    });
    const regData = await regResp.json() as { agent_id: string };
    const agentId = regData.agent_id;

    // Send first prompt
    await fetch(`${hub3.baseUrl}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: 'First',
        options: ['1', '2'],
      }),
    });

    // Try to send second prompt - should fail with 409
    const secondResp = await fetch(`${hub3.baseUrl}/api/ui/prompts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agentId,
        prompt: 'Second',
        options: ['3', '4'],
      }),
    });
    expect(secondResp.status).toBe(409);
    const errData = await secondResp.json() as { error: string };
    expect(errData.error).toBe('pending_choice_exists');

    await hub3.close();
  });
});
