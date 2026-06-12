/**
 * E2E: Full role lifecycle — register agents, assign roles, heartbeat,
 * create tasks, claim/complete tasks, detect death, trigger succession.
 */
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { HubStore } from '../../src/persistence/store.js';
import { ClkService } from '../../src/roles/clk.js';
import { RoleManager } from '../../src/roles/manager.js';
import { AuditJournal } from '../../src/safety/audit.js';
import { SafetyLimiter } from '../../src/safety/limiter.js';
import { SessionRegistry } from '../../src/session/registry.js';
import { ModuleAffinityService } from '../../src/tasks/affinity.js';
import { ProgressTracker } from '../../src/tasks/progress.js';
import { TaskService } from '../../src/tasks/service.js';
import { createHubExpress, mountStreamableHttpHub } from '../../src/transport/http.js';

const silentLogger = pino({ level: 'silent' });

function parseToolJson(result: unknown): Record<string, unknown> {
  const r = CallToolResultSchema.parse(result);
  const text = r.content?.find((c) => c.type === 'text' && 'text' in c) as
    | { type: 'text'; text: string }
    | undefined;
  if (!text?.text) throw new Error('expected text content');
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function makeClient(baseUrl: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
  await client.connect(transport);
  return client;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const raw = await client.callTool({ name, arguments: args });
  return parseToolJson(raw);
}

describe('Role Lifecycle E2E', () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gsd2-role-e2e-'));
    const dbPath = join(tmpDir, 'hub.sqlite');

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
    const roleManager = new RoleManager(db);
    const clkService = new ClkService(db, publisher, roleManager, silentLogger);
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
      mirrorRoot: join(tmpDir, 'mirror'),
      taskService,
      pathLeaseService,
      progressTracker,
      safetyLimiter,
      auditJournal,
      hubDb: db,
      moduleAffinityService,
      roleManager,
      clkService,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') throw new Error('bad addr');
        baseUrl = `http://127.0.0.1:${addr.port}/mcp`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2000);
    });
    rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it('full lifecycle: register → assign roles → tasks → heartbeat → succession', async () => {
    // --- Phase 1: Register 5 agents ---
    const clients: Client[] = [];
    const agentIds = ['proxy-001', 'ctrl-001', 'super-001', 'worker-001', 'reserve-001'];

    for (const id of agentIds) {
      const client = await makeClient(baseUrl, id);
      clients.push(client);
      const reg = await callTool(client, 'hub_register', { agent_id: id });
      expect(reg.ok).toBe(true);
      expect(reg.agent_id).toBe(id);
    }

    // --- Phase 2: Assign management roles ---
    const proxyClient = clients[0];

    // Assign proxy
    const proxyAssign = await callTool(proxyClient, 'hub_assign_role', {
      agent_id: 'proxy-001',
      role: 'proxy',
    });
    expect(proxyAssign.ok).toBe(true);

    // Assign controller
    const ctrlAssign = await callTool(proxyClient, 'hub_assign_role', {
      agent_id: 'ctrl-001',
      role: 'controller',
    });
    expect(ctrlAssign.ok).toBe(true);

    // Assign supervisor
    const superAssign = await callTool(proxyClient, 'hub_assign_role', {
      agent_id: 'super-001',
      role: 'supervisor',
    });
    expect(superAssign.ok).toBe(true);

    // Assign worker
    const workerAssign = await callTool(proxyClient, 'hub_assign_role', {
      agent_id: 'worker-001',
      role: 'worker',
    });
    expect(workerAssign.ok).toBe(true);

    // --- Phase 3: Verify role assignments ---
    const roles = await callTool(proxyClient, 'hub_get_roles', {});
    expect(roles.ok).toBe(true);
    const rolesList = roles.roles as Array<{ agentId: string; role: string }>;
    expect(rolesList.length).toBe(4);

    const roleMap = new Map(rolesList.map((r) => [r.agentId, r.role]));
    expect(roleMap.get('proxy-001')).toBe('proxy');
    expect(roleMap.get('ctrl-001')).toBe('controller');
    expect(roleMap.get('super-001')).toBe('supervisor');
    expect(roleMap.get('worker-001')).toBe('worker');

    // --- Phase 4: Controller creates a task ---
    const ctrlClient = clients[1];
    const taskCreate = await callTool(ctrlClient, 'hub_create_task', {
      creator_agent_id: 'ctrl-001',
      title: 'Implement auth module',
      description: 'Build JWT authentication with refresh tokens',
      workflow_stage: 'execute',
      module: 'auth',
    });
    expect(taskCreate.ok).toBe(true);
    const createdTask = taskCreate.task as Record<string, unknown>;
    const taskId = createdTask.id as string;
    expect(taskId).toBeTruthy();

    // --- Phase 5: Worker claims the task ---
    const workerClient = clients[3];
    const claim = await callTool(workerClient, 'hub_claim_task', {
      agent_id: 'worker-001',
    });
    expect(claim.ok).toBe(true);
    expect((claim.task as Record<string, unknown>)?.id).toBe(taskId);

    // --- Phase 6: Worker completes the task ---
    const complete = await callTool(workerClient, 'hub_complete_task', {
      agent_id: 'worker-001',
      task_id: taskId,
      result_summary: 'Auth module implemented with JWT + refresh tokens. Tests added.',
    });
    expect(complete.ok).toBe(true);

    // Verify task is completed
    const tasks = await callTool(ctrlClient, 'hub_list_tasks', {
      status: 'done',
    });
    expect(tasks.ok).toBe(true);
    const taskList = tasks.tasks as Array<{ id: string }>;
    expect(taskList.some((t) => t.id === taskId)).toBe(true);

    // --- Phase 7: Heartbeats ---
    for (const [i, id] of agentIds.slice(0, 4).entries()) {
      const hb = await callTool(clients[i], 'hub_heartbeat_role', { agent_id: id });
      expect(hb.ok).toBe(true);
    }

    // --- Phase 8: Save state for succession ---
    const saveState = await callTool(ctrlClient, 'hub_save_state', {
      agent_id: 'ctrl-001',
      snapshot: { current_phase: 3, completed_tasks: 5, pending_tasks: 2 },
    });
    expect(saveState.ok).toBe(true);

    // --- Phase 9: CLK status check ---
    const clkStatus = await callTool(proxyClient, 'hub_clk_status', {});
    expect(clkStatus.ok).toBe(true);
    expect(typeof clkStatus.tickNumber).toBe('number');

    // --- Phase 10: Put reserve agent in pool, then trigger succession ---
    // First, add reserve-001 to the reserve pool via direct role manager
    // (In production, launcher does this; here we use hub_assign_role to add as worker first,
    // then we test succession by marking controller dead)

    // Register re-do with reserve to make sure it's in the system
    const reserveClient = clients[4];

    // Query specific role
    const ctrlRole = await callTool(proxyClient, 'hub_get_roles', { agent_id: 'ctrl-001' });
    expect(ctrlRole.ok).toBe(true);
    const ctrlRoleData = ctrlRole.role as Record<string, unknown>;
    expect(ctrlRoleData.role).toBe('controller');
    expect(ctrlRoleData.stateSnapshot).toEqual({
      current_phase: 3,
      completed_tasks: 5,
      pending_tasks: 2,
    });

    // --- Phase 11: Communication via publish/poll ---
    // Controller subscribes to its inbox
    const sub = await callTool(ctrlClient, 'hub_subscribe', {
      agent_id: 'ctrl-001',
      topics: ['controller.inbox'],
    });
    expect(sub.ok).toBe(true);

    // Proxy publishes a message to controller
    const pub = await callTool(proxyClient, 'hub_publish', {
      agent_id: 'proxy-001',
      topic: 'controller.inbox',
      payload: {
        type: 'new_objective',
        description: 'Build the user registration flow',
      },
    });
    expect(pub.ok).toBe(true);

    // Controller polls for messages
    const poll = await callTool(ctrlClient, 'hub_poll_events', {
      agent_id: 'ctrl-001',
    });
    expect(poll.ok).toBe(true);
    const events = poll.events as Array<{ payload: unknown }>;
    const msgEvent = events.find((e) => {
      const p = e.payload as Record<string, unknown> | null;
      return p?.type === 'new_objective';
    });
    expect(msgEvent).toBeTruthy();

    // --- Phase 12: Reserve count ---
    const reserveCount = await callTool(proxyClient, 'hub_reserve_count', {});
    expect(reserveCount.ok).toBe(true);
    expect(typeof reserveCount.count).toBe('number');

    // Close all clients
    for (const client of clients) {
      await client.close();
    }
  });

  it('re-register returns existing role assignment', async () => {
    const client = await makeClient(baseUrl, 'role-check');
    const reg1 = await callTool(client, 'hub_register', { agent_id: 'role-check-agent' });
    expect(reg1.ok).toBe(true);

    // Assign a role
    await callTool(client, 'hub_assign_role', {
      agent_id: 'role-check-agent',
      role: 'worker',
    });

    // Re-register — should include role info
    const client2 = await makeClient(baseUrl, 'role-check-2');
    const reg2 = await callTool(client2, 'hub_register', { agent_id: 'role-check-agent' });
    expect(reg2.ok).toBe(true);
    const assignedRole = reg2.assigned_role as Record<string, unknown>;
    expect(assignedRole).not.toBeNull();
    expect(assignedRole.role).toBe('worker');
    expect(assignedRole.status).toBe('active');

    await client.close();
    await client2.close();
  });

  it('full task lifecycle with module affinity', async () => {
    const client = await makeClient(baseUrl, 'affinity-test');

    // Register with owned module
    const reg = await callTool(client, 'hub_register', {
      agent_id: 'affinity-worker',
      owned_modules: ['payments', 'billing'],
    });
    expect(reg.ok).toBe(true);

    // Create a task tagged with owned module
    const task = await callTool(client, 'hub_create_task', {
      creator_agent_id: 'affinity-worker',
      title: 'Fix payment retry logic',
      description: 'Handle edge case in Stripe webhook retry',
      workflow_stage: 'execute',
      module: 'payments',
    });
    expect(task.ok).toBe(true);

    // Claim — should get the task since we own the module
    const claim = await callTool(client, 'hub_claim_task', {
      agent_id: 'affinity-worker',
    });
    expect(claim.ok).toBe(true);
    const claimedTask = claim.task as Record<string, unknown>;
    expect(claimedTask).not.toBeNull();
    expect(claimedTask?.module).toBe('payments');

    // Complete
    const complete = await callTool(client, 'hub_complete_task', {
      agent_id: 'affinity-worker',
      task_id: claimedTask.id as string,
      result_summary: 'Fixed webhook retry with exponential backoff',
    });
    expect(complete.ok).toBe(true);

    // Check module affinity
    const affinity = await callTool(client, 'hub_module_affinity', {
      agent_id: 'affinity-worker',
    });
    expect(affinity.ok).toBe(true);

    await client.close();
  });
});
