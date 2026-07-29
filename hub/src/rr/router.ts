import { Router, type Request, type Response } from 'express';
import type pino from 'pino';
import {
  armAfk,
  configureMasterSession,
  haltAfkOrchestrator,
  oneClickAfk,
  readAfkStatus,
  startAfkOrchestrator,
} from './afk-service.js';
import { defaultRrWorkspace } from './cursor-spawn.js';
import { loadConfig } from './orchestrator/config.js';
import { readOrchestratorHealth } from './orchestrator/health.js';
import { CursorSpawnQueue } from './spawn-queue.js';
import type { RrFileStore } from './store.js';
import type { RrSession } from './types.js';

export interface RrRouterDeps {
  store: RrFileStore;
  logger?: pino.Logger;
  storeBridgeIntervalMs?: number;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'session_not_found') return 404;
  if (message === 'session_deleted') return 410;
  if (message === 'target_busy' || message === 'target_offline' || message === 'task_not_active' || message === 'task_id_mismatch') return 409;
  if (message === 'cursor_cli_not_found' || message === 'cursor_spawn_failed') return 503;
  if (message.startsWith('polarprocess_')) return 503;
  if (message === 'batch_not_found') return 404;
  if (message === 'afk_already_active' || message === 'no_master_session') return 409;
  if (message.startsWith('invalid_') || message === 'target_not_subagent') return 400;
  return 500;
}

export function createRrRouter({ store, logger, storeBridgeIntervalMs = 1_000 }: RrRouterDeps): Router {
  const router = Router();
  const sseClients = new Set<Response>();
  let lastDigest = '';

  const notify = (event: string, data: unknown) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(chunk); } catch { sseClients.delete(client); }
    }
  };

  const spawnQueue = new CursorSpawnQueue(store, {
    logger,
    onUpdate: (batch, job) => {
      notify('rr_spawn_queue_updated', {
        status: spawnQueue.getStatus(),
        batch,
        job,
      });
    },
  });

  const bridge = setInterval(() => {
    try {
      const sessions = store.listSessions();
      const digest = JSON.stringify(sessions.map((session) => [
        session.sessionId,
        session.lastActiveAt,
        session.status,
        session.pendingMessages,
        session.isSubagent,
        session.activeTask?.updatedAt,
      ]));
      if (lastDigest && digest !== lastDigest) notify('rr_store_changed', { sessions: sessions.length });
      lastDigest = digest;
    } catch (error) {
      logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'rr store bridge failed');
    }
  }, Math.max(50, storeBridgeIntervalMs));
  bridge.unref();

  const handleError = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error({ err: message }, 'rr route error');
    res.status(errorStatus(error)).json({ ok: false, error: message });
  };

  router.get('/ui/rr/sessions', (_req, res) => {
    try { res.json({ sessions: store.listSessions() }); } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions', (req, res) => {
    try {
      const body = req.body as { sessionId?: string; launchId?: string; name?: string; role?: string };
      const result = store.register({
        sessionId: body.sessionId,
        launchId: body.launchId,
        name: body.name?.trim() || 'Rr Agent',
        role: body.role,
      });
      notify('rr_session_updated', result.session);
      res.status(result.deduplicated ? 200 : 201).json(result);
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/sessions/:sessionId', (req, res) => {
    try {
      res.json({
        session: store.getSession(req.params.sessionId),
        history: store.getHistory(req.params.sessionId),
      });
    } catch (error) { handleError(res, error); }
  });

  router.patch('/ui/rr/sessions/:sessionId', (req, res) => {
    try {
      const body = req.body as { title?: string; agentStatus?: string; isSubagent?: boolean; titleLocked?: boolean };
      let session = store.updateSession(req.params.sessionId, {
        title: body.title,
        agentStatus: body.agentStatus,
        // 面板用户重命名时带 titleLocked:true；Hub 自动 stamp 不带，且尊重已锁会话
        ...(body.titleLocked === true ? { titleLocked: true } : {}),
      });
      if (typeof body.isSubagent === 'boolean') session = store.setSubagent(req.params.sessionId, body.isSubagent);
      notify('rr_session_updated', session);
      res.json({ session });
    } catch (error) { handleError(res, error); }
  });

  router.delete('/ui/rr/sessions/:sessionId', (req, res) => {
    try {
      const sessionId = req.params.sessionId;
      spawnQueue.cancelJobsForSession(sessionId);
      store.removeSession(sessionId);
      notify('rr_session_removed', { sessionId });
      res.json({ ok: true });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions/:sessionId/messages', (req, res) => {
    try {
      const body = req.body as { content?: string };
      if (!body.content) throw new Error('invalid_message');
      const message = store.enqueueUserMessage(req.params.sessionId, body.content);
      notify('rr_message_created', { sessionId: req.params.sessionId, message });
      res.status(201).json({ message });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions/:sessionId/dispatch', (req, res) => {
    try {
      const body = req.body as { targetSessionId?: string; content?: string };
      if (!body.targetSessionId || !body.content) throw new Error('invalid_dispatch');
      const task = store.dispatchSubagentTask(req.params.sessionId, body.targetSessionId, body.content);
      notify('rr_message_created', { sessionId: body.targetSessionId, taskId: task.taskId });
      res.status(201).json({ task });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions/spawn-cursor', async (req, res) => {
    try {
      const body = req.body as {
        sessionId?: string;
        launchId?: string;
        name?: string;
        role?: string;
        workspace?: string;
        headless?: boolean;
        waitUntilOnline?: boolean;
      };

      let session;
      let created = false;
      if (body.sessionId) {
        session = store.getSession(body.sessionId);
      } else {
        const launchId = body.launchId ?? `rrlaunch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const result = store.register({
          launchId,
          name: body.name?.trim() || 'Rr Agent',
          role: body.role,
        });
        session = result.session;
        created = !result.deduplicated;
        notify('rr_session_updated', session);
      }

      const spawnResult = await spawnQueue.enqueue({
        session,
        workspace: body.workspace,
        headless: body.headless,
        waitUntilOnline: body.waitUntilOnline ?? false,
        label: session.name,
      });

      res.status(created ? 201 : 200).json({
        session: store.getSession(session.sessionId),
        created,
        spawn: spawnResult,
        queue: spawnQueue.getStatus(),
      });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions/:sessionId/spawn-cursor', async (req, res) => {
    try {
      const body = req.body as { workspace?: string; headless?: boolean; waitUntilOnline?: boolean };
      const session = store.getSession(req.params.sessionId);
      const spawnResult = await spawnQueue.enqueue({
        session,
        workspace: body.workspace,
        headless: body.headless,
        waitUntilOnline: body.waitUntilOnline ?? false,
        label: session.name,
      });
      res.json({
        session: store.getSession(session.sessionId),
        spawn: spawnResult,
        queue: spawnQueue.getStatus(),
      });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/sessions/spawn-process', async (req, res) => {
    try {
      const body = req.body as {
        stamp?: string;
        workspace?: string;
        subCount?: number;
        headless?: boolean;
      };
      const stamp = body.stamp?.trim() || new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const workspace = body.workspace;
      const subCount = Math.max(0, Math.min(4, body.subCount ?? 2));
      const batch = spawnQueue.createBatch();

      const mainResult = store.register({
        launchId: `rrlaunch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Rr Agent · 主',
        role: 'general-purpose',
      });
      let mainSession = store.updateSession(mainResult.session.sessionId, { title: `主 · ${stamp}` });
      notify('rr_session_updated', mainSession);

      const subSessions: RrSession[] = [];
      for (let index = 1; index <= subCount; index += 1) {
        const created = store.register({
          launchId: `rrlaunch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          name: `Rr Agent · 子${index}`,
          role: 'general-purpose',
        });
        let sub = store.updateSession(created.session.sessionId, { title: `子${index} · ${stamp}` });
        sub = store.setSubagent(created.session.sessionId, true);
        subSessions.push(sub);
        notify('rr_session_updated', sub);
      }

      void spawnQueue.enqueue({
        session: mainSession,
        workspace,
        headless: body.headless,
        waitUntilOnline: true,
        label: mainSession.title || mainSession.name,
      }, batch.batchId).catch((error) => {
        logger?.error({ err: error instanceof Error ? error.message : String(error), sessionId: mainSession.sessionId }, 'rr spawn-process main enqueue failed');
      });

      for (const sub of subSessions) {
        void spawnQueue.enqueue({
          session: sub,
          workspace,
          headless: body.headless,
          waitUntilOnline: true,
          label: sub.title || sub.name,
        }, batch.batchId).catch((error) => {
          logger?.error({ err: error instanceof Error ? error.message : String(error), sessionId: sub.sessionId }, 'rr spawn-process sub enqueue failed');
        });
      }

      res.status(202).json({
        batchId: batch.batchId,
        batch: spawnQueue.getBatch(batch.batchId),
        mainSessionId: mainSession.sessionId,
        subSessionIds: subSessions.map((sub) => sub.sessionId),
        queue: spawnQueue.getStatus(),
      });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/spawn-queue/status', (_req, res) => {
    try {
      res.json({
        queue: spawnQueue.getStatus(),
        latestBatch: spawnQueue.getLatestBatch(),
      });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/spawn-queue/:batchId', (req, res) => {
    try {
      const batch = spawnQueue.getBatch(req.params.batchId);
      if (!batch) throw new Error('batch_not_found');
      res.json({ batch, queue: spawnQueue.getStatus() });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/subagents', (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      res.json({ subagents: store.listSubagents(sessionId) });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/runtime', (_req, res) => {
    try {
      const orchestrator = loadConfig();
      res.json({
        defaultWorkspace: defaultRrWorkspace(orchestrator.projectRoot),
        orchestratorProjectRoot: orchestrator.projectRoot,
        proxyHint: 'PolarProcess injects HTTP_PROXY for Hub-spawned cursor-agent',
        spawnGapMs: Number(process.env.RR_SPAWN_GAP_MS ?? 5_000),
        spawnWaitOnlineMs: Number(process.env.RR_SPAWN_WAIT_ONLINE_MS ?? 90_000),
      });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/orchestrator/health', (req, res) => {
    try {
      const projectRoot = typeof req.query.projectRoot === 'string' ? req.query.projectRoot : undefined;
      res.json(readOrchestratorHealth(projectRoot));
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/afk/status', async (req, res) => {
    try {
      const projectRoot = typeof req.query.projectRoot === 'string' ? req.query.projectRoot : undefined;
      res.json(await readAfkStatus(projectRoot));
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/afk/arm', (req, res) => {
    try {
      const body = req.body as {
        taskDir?: string
        taskSlug?: string
        maxLoops?: number
        force?: boolean
        projectRoot?: string
        masterSessionId?: string
      };
      const result = armAfk(body);
      if (body.masterSessionId) configureMasterSession(body.masterSessionId, body.projectRoot);
      res.status(201).json({ ok: true, ...result });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/afk/one-click', async (req, res) => {
    try {
      const body = req.body as {
        sessionId?: string
        masterSessionId?: string
        taskDir?: string
        taskSlug?: string
        maxLoops?: number
        force?: boolean
        projectRoot?: string
        spawnIfNeeded?: boolean
        startOrchestrator?: boolean
      };
      const result = await oneClickAfk(store, {
        ...body,
        sessionId: body.sessionId ?? body.masterSessionId,
      });
      notify('rr_afk_updated', result.status);
      res.status(201).json(result);
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/afk/orchestrator/start', async (_req, res) => {
    try {
      const result = await startAfkOrchestrator();
      notify('rr_afk_updated', { action: 'orchestrator_start' });
      res.json({ ok: true, ...result });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/rr/afk/orchestrator/halt', async (_req, res) => {
    try {
      const result = await haltAfkOrchestrator();
      notify('rr_afk_updated', { action: 'orchestrator_halt' });
      res.json({ ok: true, ...result });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/rr/stream', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); sseClients.delete(res); }
    }, 20_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  return router;
}

