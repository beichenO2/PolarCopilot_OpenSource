/**
 * Module-owner affinity scheduling: agents that "own" a module (declared or earned)
 * get priority for tasks tagged with that module.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import pino from 'pino';
import { BroadcastPublisher } from '../../src/broadcast/publisher.js';
import { SseHub } from '../../src/broadcast/sse-hub.js';
import { EventSubscriber } from '../../src/broadcast/subscriber.js';
import { createHubDatabase } from '../../src/persistence/db.js';
import { PathLeaseService } from '../../src/persistence/path-leases.js';
import { AuditJournal } from '../../src/safety/audit.js';
import { SafetyLimiter } from '../../src/safety/limiter.js';
import { HubStore } from '../../src/persistence/store.js';
import { SessionRegistry } from '../../src/session/registry.js';
import { ModuleAffinityService } from '../../src/tasks/affinity.js';
import { ProgressTracker } from '../../src/tasks/progress.js';
import { TaskService } from '../../src/tasks/service.js';
import { createHubExpress, mountStreamableHttpHub } from '../../src/transport/http.js';

const silentLogger = pino({ level: 'silent' });

type TaskRow = {
  id: string;
  status: string;
  owner_agent_id: string | null;
  module: string | null;
};

function parseToolJson(result: unknown): Record<string, unknown> {
  const r = CallToolResultSchema.parse(result);
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as { type: 'text'; text: string } | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'e2e-affinity', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return client.request(
    { method: 'tools/call', params: { name, arguments: args } },
    CallToolResultSchema,
  );
}

type RunningHub = {
  baseUrl: string;
  close: () => Promise<void>;
};

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
  const moduleAffinityService = new ModuleAffinityService(db, safetyLimiter);
  taskService.setLimiter(safetyLimiter);
  taskService.setAffinityService(moduleAffinityService);
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
    moduleAffinityService,
  });

  let server: Server;
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(`http://127.0.0.1:${addr.port}/mcp`);
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

describe('e2e — module-owner affinity scheduling', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-e2e-affinity-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('declared module owner gets task priority', async () => {
    const hub = await startHub(join(workDir, 'mod1.sqlite'), workDir);

    // Register auth-agent as owner of "auth" module
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', {
        agent_id: 'auth-agent',
        owned_modules: ['auth', 'session'],
      });
    });

    // Register generic-agent with no module ownership
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'generic-agent' });
    });

    // Create a task tagged with module "auth"
    let taskId = '';
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'boss' });
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'boss',
          title: 'Fix auth token refresh',
          workflow_stage: 'execute',
          priority: 10,
          module: 'auth',
        }),
      );
      taskId = (created.task as TaskRow).id;
      expect((created.task as TaskRow).module).toBe('auth');
    });

    // generic-agent tries to claim → should yield to auth-agent
    const genericClaim = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'generic-agent' });
      return parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'generic-agent',
          lease_duration_ms: 600_000,
        }),
      );
    });

    expect(genericClaim.task).toBeNull();
    expect(genericClaim.scheduling_hint).toBeDefined();
    const hint = genericClaim.scheduling_hint as Record<string, unknown>;
    expect(hint.reason).toBe('module_affinity_yield');
    expect(hint.preferred_agent).toBe('auth-agent');

    // auth-agent claims → should succeed
    const authClaim = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'auth-agent', owned_modules: ['auth', 'session'] });
      return parseToolJson(
        await callTool(c, 'hub_claim_task', {
          agent_id: 'auth-agent',
          lease_duration_ms: 600_000,
        }),
      );
    });

    expect(authClaim.task).not.toBeNull();
    expect((authClaim.task as TaskRow).id).toBe(taskId);

    await hub.close();
  });

  it('earned affinity: completing a module task builds ownership', async () => {
    const hub = await startHub(join(workDir, 'mod2.sqlite'), workDir);

    // Register two agents, neither declares module ownership
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-x' });
    });
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-y' });
    });

    // Create and let agent-x complete a "payments" task → earns affinity
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'boss' });
      await callTool(c, 'hub_create_task', {
        creator_agent_id: 'boss',
        title: 'Init payment gateway',
        workflow_stage: 'execute',
        priority: 10,
        module: 'payments',
      });
    });

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-x' });
      const claimed = parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'agent-x', lease_duration_ms: 600_000 }),
      );
      const t = claimed.task as TaskRow;
      expect(t).not.toBeNull();
      await callTool(c, 'hub_complete_task', { agent_id: 'agent-x', task_id: t.id });
    });

    // Now create another "payments" task → agent-x should get priority
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'boss' });
      await callTool(c, 'hub_create_task', {
        creator_agent_id: 'boss',
        title: 'Add refund support',
        workflow_stage: 'execute',
        priority: 10,
        module: 'payments',
      });
    });

    // agent-y tries to claim → should yield to agent-x (earned owner)
    const yClaim = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-y' });
      return parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'agent-y', lease_duration_ms: 600_000 }),
      );
    });

    expect(yClaim.task).toBeNull();
    expect(yClaim.scheduling_hint).toBeDefined();
    expect((yClaim.scheduling_hint as Record<string, unknown>).preferred_agent).toBe('agent-x');

    // agent-x claims → succeeds
    const xClaim = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-x' });
      return parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'agent-x', lease_duration_ms: 600_000 }),
      );
    });

    expect(xClaim.task).not.toBeNull();

    await hub.close();
  });

  it('untagged tasks still available to any agent', async () => {
    const hub = await startHub(join(workDir, 'mod3.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-a', owned_modules: ['frontend'] });
    });

    // Create an untagged task (no module)
    let taskId = '';
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'boss' });
      const created = parseToolJson(
        await callTool(c, 'hub_create_task', {
          creator_agent_id: 'boss',
          title: 'Write docs',
          workflow_stage: 'execute',
          priority: 5,
        }),
      );
      taskId = (created.task as TaskRow).id;
    });

    // agent-a can claim untagged task even though they own "frontend"
    const claim = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'agent-a', owned_modules: ['frontend'] });
      return parseToolJson(
        await callTool(c, 'hub_claim_task', { agent_id: 'agent-a', lease_duration_ms: 600_000 }),
      );
    });

    expect(claim.task).not.toBeNull();
    expect((claim.task as TaskRow).id).toBe(taskId);

    await hub.close();
  });

  it('hub_module_affinity query returns correct data', async () => {
    const hub = await startHub(join(workDir, 'mod4.sqlite'), workDir);

    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'db-agent', owned_modules: ['database', 'migrations'] });
    });

    const result = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'db-agent', owned_modules: ['database', 'migrations'] });
      return parseToolJson(await callTool(c, 'hub_module_affinity', { agent_id: 'db-agent' }));
    });

    expect(result.ok).toBe(true);
    const modules = result.agent_modules as { module: string; source: string }[];
    expect(modules.map((m) => m.module)).toContain('database');
    expect(modules.map((m) => m.module)).toContain('migrations');
    expect(modules.every((m) => m.source === 'declared')).toBe(true);

    // Query by module
    const byModule = await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'db-agent', owned_modules: ['database', 'migrations'] });
      return parseToolJson(await callTool(c, 'hub_module_affinity', { module: 'database' }));
    });

    expect(byModule.ok).toBe(true);
    const owners = byModule.module_owners as { agent_id: string }[];
    expect(owners.map((o) => o.agent_id)).toContain('db-agent');

    await hub.close();
  });

  it('ModuleAffinityService unit test', () => {
    const { db } = createHubDatabase(':memory:');
    const limiter = new SafetyLimiter(db);
    const svc = new ModuleAffinityService(db, limiter);

    svc.declareOwnership('agent-1', ['auth', 'users']);
    svc.declareOwnership('agent-2', ['payments']);

    expect(svc.findBestAgent('auth')?.agent_id).toBe('agent-1');
    expect(svc.findBestAgent('payments')?.agent_id).toBe('agent-2');
    expect(svc.findBestAgent('unknown')).toBeNull();

    // Earn affinity
    svc.recordCompletion('agent-3', 'auth');
    svc.recordCompletion('agent-3', 'auth');

    // Declared still wins over earned
    const best = svc.findBestAgent('auth');
    expect(best?.agent_id).toBe('agent-1');
    expect(best?.source).toBe('declared');

    // For a module with only earned affinity
    svc.recordCompletion('agent-3', 'logging');
    svc.recordCompletion('agent-3', 'logging');
    svc.recordCompletion('agent-4', 'logging');

    const loggingBest = svc.findBestAgent('logging');
    expect(loggingBest?.agent_id).toBe('agent-3');
    expect(loggingBest?.completed_count).toBe(2);

    // Agent modules query
    const mods = svc.getAgentModules('agent-1');
    expect(mods.map((m) => m.module).sort()).toEqual(['auth', 'users']);
  });
});
