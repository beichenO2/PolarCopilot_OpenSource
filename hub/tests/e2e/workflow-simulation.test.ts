/**
 * 完整工作流模拟测试
 *
 * 模拟整个 gsd-2 集群的工作流程：
 * - 代理(Proxy): 下达 phase_objective
 * - 主控(Controller): 拆解任务、分配工人、监控 CLK
 * - 超管(Supervisor): 审查工人代码质量、检测劣化、上报 CLK
 * - CLK: tick 心跳、流程健康监控、执行换人
 * - 工人(Worker): 领任务、执行、报告
 *
 * 任务内容：工人互相检查彼此工作有没有问题
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
import { HubStore } from '../../src/persistence/store.js';
import { AuditJournal } from '../../src/safety/audit.js';
import { SafetyLimiter } from '../../src/safety/limiter.js';
import { SessionRegistry } from '../../src/session/registry.js';
import { ProgressTracker } from '../../src/tasks/progress.js';
import { TaskService } from '../../src/tasks/service.js';
import { ClkService } from '../../src/roles/clk.js';
import { RoleManager } from '../../src/roles/manager.js';
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

async function withClient<T>(baseUrl: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: 'sim-test', version: '0.0.0' });
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
  const auditJournal = new AuditJournal(db);
  const safetyLimiter = new SafetyLimiter(db);
  const roleManager = new RoleManager(db);
  const clkService = new ClkService(db, publisher, roleManager, silentLogger);
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
    roleManager,
    clkService,
  });

  let server: Server;
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}/mcp`);
      else reject(new Error('no listen address'));
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

describe('workflow simulation: full cluster lifecycle', () => {
  let workDir: string;
  let hub: RunningHub;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'gsd2-sim-'));
    hub = await startHub(join(workDir, 'sim.sqlite'), workDir);
  });

  afterAll(async () => {
    await hub.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('Phase 1: all agents register and get roles', async () => {
    const agents = ['proxy', 'ctrl', 'super', 'worker-01', 'worker-02', 'worker-03'];

    for (const agentId of agents) {
      await withClient(hub.baseUrl, async (c) => {
        const reg = parseToolJson(await callTool(c, 'hub_register', { agent_id: agentId }));
        expect(reg.ok).toBe(true);
      });
    }
  });

  it('Phase 2: proxy sends phase_objective to controller', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'proxy' });

      const published = parseToolJson(
        await callTool(c, 'hub_publish', {
          agent_id: 'proxy',
          topic: 'ctrl.inbox',
          payload: {
            type: 'phase_objective',
            phase: 1,
            goal: '各工人互相检查彼此的工作流程',
            requirements: [
              'worker-01 检查 worker-02 的心跳是否正常',
              'worker-02 检查 worker-03 的心跳是否正常',
              'worker-03 检查 worker-01 的心跳是否正常',
            ],
          },
        }),
      );
      expect(published.ok).toBe(true);
    });
  });

  it('Phase 3: controller receives objective and creates tasks', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'ctrl' });

      // 主控轮询收到代理的 phase_objective
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'ctrl' }),
      );
      expect(polled.ok).toBe(true);
      const events = polled.events as { topic: string; payload: Record<string, unknown> }[];
      const objective = events.find(
        (e) => (e.payload as { type?: string })?.type === 'phase_objective',
      );
      expect(objective).toBeDefined();

      // 主控根据 requirements 创建 3 个检查任务
      const taskTitles = [
        'worker-01 检查 worker-02 心跳',
        'worker-02 检查 worker-03 心跳',
        'worker-03 检查 worker-01 心跳',
      ];

      for (let i = 0; i < taskTitles.length; i++) {
        const created = parseToolJson(
          await callTool(c, 'hub_create_task', {
            creator_agent_id: 'ctrl',
            title: taskTitles[i],
            description: `检查对方的心跳响应和工作状态是否正常`,
            workflow_stage: 'verify',
            priority: 10 - i,
          }),
        );
        expect((created.task as { id: string }).id).toBeTruthy();
      }

      // 主控检查 CLK 状态（不监督工人质量）
      const clkStatus = parseToolJson(
        await callTool(c, 'hub_clk_status', {}),
      );
      expect(clkStatus.ok).toBe(true);

      // 主控向代理报告已拆解任务
      const report = parseToolJson(
        await callTool(c, 'hub_publish', {
          agent_id: 'ctrl',
          topic: 'proxy.inbox',
          payload: {
            type: 'progress_report',
            from: 'ctrl',
            summary: '已创建 3 个互检任务，等待工人领取',
          },
        }),
      );
      expect(report.ok).toBe(true);
    });
  });

  it('Phase 4: workers claim and complete tasks', async () => {
    const workers = ['worker-01', 'worker-02', 'worker-03'];

    for (const workerId of workers) {
      await withClient(hub.baseUrl, async (c) => {
        await callTool(c, 'hub_register', { agent_id: workerId });

        // 领取任务
        const claimed = parseToolJson(
          await callTool(c, 'hub_claim_task', { agent_id: workerId }),
        );
        const task = claimed.task as { id: string } | null;
        expect(task).not.toBeNull();

        // 工人执行心跳检查
        await callTool(c, 'hub_heartbeat_role', { agent_id: workerId });

        // 完成任务（工人只干活不判断别人质量）
        const completed = parseToolJson(
          await callTool(c, 'hub_complete_task', {
            agent_id: workerId,
            task_id: task!.id,
            result_summary: `${workerId} 完成了互检任务：对方心跳正常，响应及时`,
          }),
        );
        expect((completed.task as { status: string }).status).toBe('done');
      });
    }
  });

  it('Phase 5: supervisor reviews completed work and evaluates controller strategy', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'super' });

      // 超管查看已完成任务
      const list = parseToolJson(
        await callTool(c, 'hub_list_tasks', { status: 'done' }),
      );
      const tasks = list.tasks as { id: string; status: string }[];
      expect(tasks.length).toBe(3);

      // 超管审查：代码质量检查（本轮无异常）
      // 超管同时评判主控的指挥质量
      const qualityReport = parseToolJson(
        await callTool(c, 'hub_publish', {
          agent_id: 'super',
          topic: 'proxy.inbox',
          payload: {
            type: 'quality_report',
            from: 'super',
            status: 'all_clear',
            details: '3 个互检任务全部完成，工人输出正常，主控任务拆解合理',
          },
        }),
      );
      expect(qualityReport.ok).toBe(true);

      // 超管心跳
      await callTool(c, 'hub_heartbeat_role', { agent_id: 'super' });
    });
  });

  it('Phase 6: supervisor detects degradation and reports to CLK', async () => {
    // 模拟超管发现 worker-02 质量劣化
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'super' });

      const degradation = parseToolJson(
        await callTool(c, 'hub_report_degradation', {
          reporter_agent_id: 'super',
          suspect_agent_id: 'worker-02',
          evidence: 'worker-02 在最近一次任务中输出了大量俄语内容，完成报告与任务要求不符',
          severity: 'critical',
        }),
      );
      expect(degradation.ok).toBe(true);
      expect(degradation.reported).toBe(true);
      // 确认通知了 CLK（不是超管自己执行换人）
      expect(degradation.notified_clk).toBe(true);
    });
  });

  it('Phase 7: CLK receives degradation report and can act on it', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'clk' });

      // CLK 轮询事件，应该收到超管的 quality_degradation 上报
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'clk' }),
      );
      expect(polled.ok).toBe(true);
      const events = polled.events as { topic: string; payload: Record<string, unknown> }[];
      const degradationEvent = events.find(
        (e) => e.topic === 'clk.inbox' && (e.payload as { type?: string })?.type === 'quality_degradation',
      );
      expect(degradationEvent).toBeDefined();
      expect((degradationEvent!.payload as { suspect_agent_id?: string }).suspect_agent_id).toBe('worker-02');
      expect((degradationEvent!.payload as { severity?: string }).severity).toBe('critical');

      // CLK 确认 Hub 健康
      const health = parseToolJson(await callTool(c, 'hub_get_health', {}));
      expect(health.ok).toBe(true);
    });
  });

  it('Phase 8: controller monitors CLK health', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'ctrl' });

      // 主控检查 CLK 状态
      const clkStatus = parseToolJson(
        await callTool(c, 'hub_clk_status', {}),
      );
      expect(clkStatus.ok).toBe(true);
      // tickNumber 应该 >= 0（CLK 可能还没启动 tick）
      expect(typeof (clkStatus as { tickNumber?: number }).tickNumber).toBe('number');
    });
  });

  it('Phase 9: proxy monitors cluster and detects resource state', async () => {
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'proxy' });

      // 代理检查系统资源
      const resources = parseToolJson(
        await callTool(c, 'hub_system_resources', {}),
      );
      expect(resources.ok).toBe(true);
      const res = resources.resources as {
        cpu: { cores: number; usage_pct: number };
        memory: { usage_pct: number };
        capacity: { at_90_pct_limit: boolean };
      };
      expect(res.cpu.cores).toBeGreaterThan(0);
      expect(typeof res.memory.usage_pct).toBe('number');

      // 代理检查整体健康
      const health = parseToolJson(await callTool(c, 'hub_get_health', {}));
      expect(health.ok).toBe(true);

      // 代理轮询收到超管的质量报告和主控的进度报告
      const polled = parseToolJson(
        await callTool(c, 'hub_poll_events', { agent_id: 'proxy' }),
      );
      expect(polled.ok).toBe(true);
      const events = polled.events as { topic: string; payload: Record<string, unknown> }[];
      const progressReport = events.find(
        (e) => e.topic === 'proxy.inbox' && (e.payload as { type?: string })?.type === 'progress_report',
      );
      expect(progressReport).toBeDefined();
      const qualityReport = events.find(
        (e) => e.topic === 'proxy.inbox' && (e.payload as { type?: string })?.type === 'quality_report',
      );
      expect(qualityReport).toBeDefined();
    });
  });

  it('Phase 10: verify no unexpected disconnections or anomalies', async () => {
    // 最后一轮检查：所有 Agent 再次注册确认连接稳定
    const agents = ['proxy', 'ctrl', 'super', 'worker-01', 'worker-03'];

    for (const agentId of agents) {
      await withClient(hub.baseUrl, async (c) => {
        const reg = parseToolJson(await callTool(c, 'hub_register', { agent_id: agentId }));
        expect(reg.ok).toBe(true);

        // 心跳
        await callTool(c, 'hub_heartbeat_role', { agent_id: agentId });
      });
    }

    // 最终检查所有任务状态
    await withClient(hub.baseUrl, async (c) => {
      await callTool(c, 'hub_register', { agent_id: 'proxy' });
      const list = parseToolJson(
        await callTool(c, 'hub_list_tasks', { status: 'done' }),
      );
      const doneTasks = list.tasks as { id: string }[];
      expect(doneTasks.length).toBe(3);

      // 审计日志应该记录了 quality_degradation
      const audit = parseToolJson(
        await callTool(c, 'hub_get_audit_log', { limit: 20 }),
      );
      expect(audit.ok).toBe(true);
      const entries = audit.entries as { action: string }[];
      const degradationLog = entries.find((e) => e.action === 'quality.degradation');
      expect(degradationLog).toBeDefined();
    });
  });
});
