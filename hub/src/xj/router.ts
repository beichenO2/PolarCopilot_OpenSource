import { Router, type Request, type Response } from 'express';
import type pino from 'pino';
import type { XjAutomation } from './types.js';
import type { XjSkillRouter } from './skill-router.js';
import type { XjFileStore } from './store.js';

export interface XjRouterDeps {
  store: XjFileStore;
  skillRouter: XjSkillRouter;
  logger?: pino.Logger;
  storeBridgeIntervalMs?: number;
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'session_not_found') return 404;
  if (message === 'acceptance_criteria_frozen' || message === 'completion_gates_not_met') return 409;
  if (message.startsWith('invalid_')) return 400;
  return 500;
}

export function createXjRouter({ store, skillRouter, logger, storeBridgeIntervalMs = 1_000 }: XjRouterDeps): Router {
  const router = Router();
  const sseClients = new Set<Response>();
  const storeDigest = () => JSON.stringify(store.listSessions().map(
    (session) => [session.id, session.updatedAt, session.status, session.pendingCount],
  ));
  let lastStoreDigest = storeDigest();

  const notify = (event: string, data: unknown) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(chunk); } catch { sseClients.delete(client); }
    }
  };

  // The stdio MCP runs in a separate process and writes the same durable store.
  // A lightweight unref'ed watcher bridges those file changes into browser SSE.
  const storeBridgeTimer = setInterval(() => {
    try {
      const sessions = store.listSessions();
      const digest = JSON.stringify(sessions.map(
        (session) => [session.id, session.updatedAt, session.status, session.pendingCount],
      ));
      if (digest !== lastStoreDigest) notify('xj_store_changed', { sessions: sessions.length });
      lastStoreDigest = digest;
    } catch (error) {
      logger?.warn({ err: error instanceof Error ? error.message : String(error) }, 'xj store bridge failed');
    }
  }, Math.max(10, storeBridgeIntervalMs));
  storeBridgeTimer.unref();

  const handleError = (res: Response, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error({ err: message }, 'xj route error');
    res.status(errorStatus(error)).json({ ok: false, error: message });
  };

  const detail = (sessionId: string) => ({
    session: store.getSession(sessionId),
    history: store.getHistory(sessionId),
    progress: store.getProgress(sessionId),
    automation: store.getAutomation(sessionId),
  });

  router.get('/ui/xj/sessions', (_req, res) => {
    try { res.json({ sessions: store.listSessions() }); } catch (error) { handleError(res, error); }
  });

  router.post('/ui/xj/sessions', (req, res) => {
    try {
      const body = req.body as {
        client_key?: string;
        sessionId?: string;
        launchId?: string;
        name?: string;
        role?: string;
        title?: string;
        modes?: string[];
        subagent_count?: number;
      };
      const registerInput = {
        clientKey: body.client_key,
        sessionId: body.sessionId,
        launchId: body.launchId,
        name: body.launchId ? '通用 Agent' : body.name,
        role: body.launchId ? 'general-purpose' : body.role,
        title: body.title,
        modes: body.modes,
      };
      const result = body.launchId
        ? store.ensureSessionFamily({ ...registerInput, launchId: body.launchId }, 2)
        : { ...store.register(registerInput), subagents: [] };
      const session = result.deduplicated ? result.session : store.setStatus(result.session.id, 'connecting');
      const subagents = result.deduplicated
        ? result.subagents
        : result.subagents.map((child) => store.setStatus(child.id, 'connecting'));
      notify('xj_session_updated', session);
      res.status(result.deduplicated ? 200 : 201).json({ ...result, session, subagents });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/xj/sessions/:sessionId', (req, res) => {
    try { res.json(detail(req.params.sessionId)); } catch (error) { handleError(res, error); }
  });

  router.delete('/ui/xj/sessions/:sessionId', (req, res) => {
    try {
      store.removeSession(req.params.sessionId);
      notify('xj_session_removed', { session_id: req.params.sessionId });
      res.json({ ok: true });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/xj/sessions/:sessionId/messages', (req, res) => {
    try {
      const body = req.body as { content?: string };
      if (!body.content) throw new Error('invalid_message');
      const requestedSession = store.getSession(req.params.sessionId);
      const session = requestedSession.parentSessionId
        ? store.getSession(requestedSession.parentSessionId)
        : requestedSession;
      const skills = skillRouter.match(body.content, session.modes);
      const message = store.enqueueUserMessage(session.id, body.content, {
        matchedSkills: skills,
        applicationInstructions: skillRouter.buildApplicationInstructions(skills),
        ...(requestedSession.id !== session.id ? { routedFromSessionId: requestedSession.id } : {}),
      });
      notify('xj_message_created', { session_id: session.id, message });
      res.status(201).json({ message, matched_skills: skills });
    } catch (error) { handleError(res, error); }
  });

  router.patch('/ui/xj/sessions/:sessionId/modes', (req, res) => {
    try {
      const body = req.body as { modes?: string[] };
      if (!Array.isArray(body.modes)) throw new Error('invalid_modes');
      const session = store.setModes(req.params.sessionId, body.modes);
      notify('xj_session_updated', session);
      res.json({ session });
    } catch (error) { handleError(res, error); }
  });

  router.patch('/ui/xj/sessions/:sessionId/automation', (req, res) => {
    try {
      const body = req.body as {
        enabled?: boolean;
        state?: XjAutomation['state'];
        loop_limit?: number;
        acceptance_criteria?: string[];
        completed_criteria?: string[];
        todo?: string[];
      };
      const automation = store.setAutomation(req.params.sessionId, {
        enabled: body.enabled,
        state: body.state,
        loopLimit: body.loop_limit,
        acceptanceCriteria: body.acceptance_criteria,
        completedCriteria: body.completed_criteria,
        todo: body.todo,
      });
      notify('xj_automation_updated', { session_id: req.params.sessionId, automation });
      res.json({ automation });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/xj/sessions/:sessionId/pause', (req, res) => {
    try {
      const automation = store.pause(req.params.sessionId);
      notify('xj_automation_updated', { session_id: req.params.sessionId, automation });
      res.json({ automation });
    } catch (error) { handleError(res, error); }
  });

  router.post('/ui/xj/sessions/:sessionId/resume', (req, res) => {
    try {
      const automation = store.resume(req.params.sessionId);
      notify('xj_automation_updated', { session_id: req.params.sessionId, automation });
      res.json({ automation });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/xj/skills', (req, res) => {
    try {
      const message = typeof req.query.message === 'string' ? req.query.message : '';
      const skills = message ? skillRouter.match(message) : skillRouter.list();
      res.json({ skills });
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/xj/instructions', (req, res) => {
    try {
      const message = typeof req.query.message === 'string' ? req.query.message : '';
      const skills = skillRouter.match(message);
      res.type('text/markdown').send(skillRouter.buildApplicationInstructions(skills));
    } catch (error) { handleError(res, error); }
  });

  router.get('/ui/xj/stream', (req: Request, res: Response) => {
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
