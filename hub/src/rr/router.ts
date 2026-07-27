import { Router, type Request, type Response } from 'express';
import type pino from 'pino';
import type { RrFileStore } from './store.js';

export interface RrRouterDeps {
  store: RrFileStore;
  logger?: pino.Logger;
  storeBridgeIntervalMs?: number;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'session_not_found') return 404;
  if (message === 'target_busy' || message === 'target_offline' || message === 'task_not_active' || message === 'task_id_mismatch') return 409;
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
      const body = req.body as { title?: string; agentStatus?: string; isSubagent?: boolean };
      let session = store.updateSession(req.params.sessionId, { title: body.title, agentStatus: body.agentStatus });
      if (typeof body.isSubagent === 'boolean') session = store.setSubagent(req.params.sessionId, body.isSubagent);
      notify('rr_session_updated', session);
      res.json({ session });
    } catch (error) { handleError(res, error); }
  });

  router.delete('/ui/rr/sessions/:sessionId', (req, res) => {
    try {
      store.removeSession(req.params.sessionId);
      notify('rr_session_removed', { sessionId: req.params.sessionId });
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

  router.get('/ui/rr/subagents', (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined;
      res.json({ subagents: store.listSubagents(sessionId) });
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

