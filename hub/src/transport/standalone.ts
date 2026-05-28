/**
 * Standalone Hub HTTP — Agent Control + YOLO only (no ecosystem integrations).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express } from "express";
import { localhostHostValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { eq, and, isNull, sql, inArray } from "drizzle-orm";
import { ALIVE_THRESHOLD_MS as ALIVE_THRESHOLD_MS_CONST } from "../constants.js";
import type { BroadcastPublisher } from "../broadcast/publisher.js";
import type { HubContext } from "../types.js";
import { HubStore } from "../persistence/store.js";
import type { HubDb } from "../persistence/db.js";
import {
  sessions,
  uiPrompts,
  agentRoles,
  alignmentDocs,
  alignmentVersions,
  projectOwnership,
} from "../persistence/db.js";

// ── UI Interaction Routes ──────────────────────────────────────────

// ── Project Ownership Registry ─────────────────────────────────────
// Ownership now persisted in SQLite (project_ownership table).
// OwnerRecord kept for API response compatibility.
interface OwnerRecord { agent_id: string; project_path: string; registered_at: string; }

const PROMPT_POLL_MIN_INTERVAL_MS = 500;
const promptPollLastHit = new Map<string, number>();
const POLL_THROTTLE_CLEANUP_MS = 300_000;
let lastPollThrottleCleanup = Date.now();

const SUPERSEDE_DEBOUNCE_MS = 2000;
const lastSupersedeTimes = new Map<string, number>();

type PromptSseClient = { res: import('express').Response; agentId: string };
const promptSseClients = new Map<string, Set<PromptSseClient>>();

const uiSseClients = new Set<import('express').Response>();

function notifyUiSse(event: string, data: Record<string, unknown>): void {
  if (uiSseClients.size === 0) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of uiSseClients) {
    try { res.write(chunk); } catch { uiSseClients.delete(res); }
  }
}

function notifyPromptSseClients(promptId: string, event: string, data: Record<string, unknown>): void {
  const clients = promptSseClients.get(promptId);
  if (!clients || clients.size === 0) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.res.write(chunk); } catch { clients.delete(c); }
  }
  if (event === 'answered' || event === 'superseded') {
    for (const c of clients) {
      try { c.res.end(); } catch { /* ignore */ }
    }
    promptSseClients.delete(promptId);
  }
}

// ── Rate Limiter ────────────────────────────────────────────────────
const _rateLimitBuckets = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 1200;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 300_000;
let _lastRateLimitCleanup = Date.now();

function rateLimitMiddleware(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  const key = req.ip ?? '127.0.0.1';
  const now = Date.now();

  if (now - _lastRateLimitCleanup > RATE_LIMIT_CLEANUP_INTERVAL_MS) {
    _lastRateLimitCleanup = now;
    for (const [k, v] of _rateLimitBuckets) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS * 2) _rateLimitBuckets.delete(k);
    }
  }

  let bucket = _rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    _rateLimitBuckets.set(key, bucket);
  }

  bucket.count++;
  const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - bucket.count);
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT_MAX_REQUESTS));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil((bucket.windowStart + RATE_LIMIT_WINDOW_MS) / 1000)));

  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({ error: 'rate_limit_exceeded', message: `Max ${RATE_LIMIT_MAX_REQUESTS} requests per minute`, retry_after_ms: bucket.windowStart + RATE_LIMIT_WINDOW_MS - now });
    return;
  }
  next();
}

export function mountStandaloneRoutes(app: Express, db: HubDb, ctx: HubContext, publisher?: BroadcastPublisher, store?: HubStore): void {
  app.use('/api/ui', rateLimitMiddleware);
  app.use('/api/ui', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.removeHeader('ETag');
    next();
  });

  // ── Agents API ────────────────────────────────────────────────────
  app.get('/api/ui/agents', (_req, res) => {
    try {
      const sessionRows = db.select().from(sessions).all();
      const roleRows = db.select().from(agentRoles).all();
      const roleMap = new Map(roleRows.map((r) => [r.agentId, r]));

      const agents = sessionRows.map((s) => {
        const role = roleMap.get(s.agentId);
        const lastPing = s.lastPingAt ? new Date(s.lastPingAt).toISOString() : null;
        return {
          agent_id: s.agentId,
          label: s.label,
          display_name: s.displayName,
          agent_type: s.agentType ?? 'solo',
          parent_agent_id: s.parentAgentId,
          role: role?.role ?? 'unknown',
          role_status: role?.status ?? 'unassigned',
          last_ping: lastPing,
          created_at: s.createdAt,
        };
      });
      res.json(agents);
    } catch (err) {
      ctx.logger.error({ err }, 'ui agents list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Update Agent Display Name / Type ───────────────────────────────
  app.patch('/api/ui/agents/:agentId', (req, res) => {
    try {
      const { agentId } = req.params;
      const { display_name, agent_type, parent_agent_id } = req.body as {
        display_name?: string;
        agent_type?: string;
        parent_agent_id?: string | null;
      };
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (display_name !== undefined) updates.displayName = display_name;
      if (agent_type !== undefined) updates.agentType = agent_type;
      if (parent_agent_id !== undefined) updates.parentAgentId = parent_agent_id;

      db.update(sessions).set(updates).where(eq(sessions.agentId, agentId)).run();

      if (publisher && parent_agent_id !== undefined) {
        if (parent_agent_id) {
          publisher.publish({
            sourceAgentId: 'hub-system',
            topic: `${agentId}.inbox`,
            payload: { type: 'assigned', parent_agent_id, assigned_at: new Date().toISOString() },
          });
        } else {
          publisher.publish({
            sourceAgentId: 'hub-system',
            topic: `${agentId}.inbox`,
            payload: { type: 'detached', detached_at: new Date().toISOString() },
          });
        }
      }

      res.json({ ok: true, agent_id: agentId });
    } catch (err) {
      ctx.logger.error({ err }, 'ui agent update error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Purge Dead Agents ──────────────────────────────────────────────
  app.delete('/api/ui/agents/dead', async (_req, res) => {
    try {
      const DEAD_THRESHOLD_MS = 120_000;
      const cutoff = new Date(Date.now() - DEAD_THRESHOLD_MS);

      const allSessions = db.select().from(sessions).all();
      const deadAgents = allSessions.filter(
        (s) => !s.lastPingAt || new Date(s.lastPingAt).getTime() < cutoff.getTime(),
      );

      if (!deadAgents.length) {
        res.json({ ok: true, purged: 0, message: 'No dead agents found' });
        return;
      }

      const purgedIds: string[] = [];
      const purgedIdSet = new Set(deadAgents.map((a) => a.agentId));

      // Detach slaves whose parent is being purged
      for (const s of allSessions) {
        if (s.parentAgentId && purgedIdSet.has(s.parentAgentId) && !purgedIdSet.has(s.agentId)) {
          db.update(sessions)
            .set({ parentAgentId: null, updatedAt: new Date() })
            .where(eq(sessions.agentId, s.agentId))
            .run();
        }
      }

      for (const agent of deadAgents) {
        const aid = agent.agentId;
        db.delete(sessions).where(eq(sessions.agentId, aid)).run();
        db.delete(agentRoles).where(eq(agentRoles.agentId, aid)).run();
        purgedIds.push(aid);
      }

      // Kill orphan tmux sessions matching dead agent IDs
      const { exec: execCb } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execAsync = promisify(execCb);
      let killedProcesses = 0;
      for (const aid of purgedIds) {
        if (!/^[a-zA-Z0-9_-]+$/.test(aid)) continue;
        try {
          await execAsync(`tmux kill-session -t "${aid}" 2>/dev/null || true`, { timeout: 5000 });
          killedProcesses++;
        } catch { /* tmux session may not exist */ }
      }

      ctx.logger.info({ purgedIds, killedProcesses }, 'purged dead agents');
      res.json({
        ok: true,
        purged: purgedIds.length,
        agent_ids: purgedIds,
        tmux_killed: killedProcesses,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'purge dead agents error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Delete Single Agent ──────────────────────────────────────────
  app.delete('/api/ui/agents/:agentId', (req, res) => {
    try {
      const { agentId } = req.params;
      db.delete(sessions).where(eq(sessions.agentId, agentId)).run();
      db.delete(agentRoles).where(eq(agentRoles.agentId, agentId)).run();
      db.delete(projectOwnership).where(eq(projectOwnership.agentId, agentId)).run();
      res.json({ ok: true, agent_id: agentId });
    } catch (err) {
      ctx.logger.error({ err }, 'ui agent delete error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── One-step Register + First Prompt ──────────────────────────
  // Solo Web agents POST here with agent_id, display_name, prompt, options.
  // Creates the session and first prompt in one call. No MCP session needed.
  app.post('/api/ui/agents/register', (req, res) => {
    try {
      const { agent_id, display_name, prompt, options } = req.body as {
        agent_id?: string;
        display_name?: string;
        prompt?: string;
        options?: string[];
      };
      if (!agent_id || !display_name || !prompt) {
        res.status(400).json({ error: 'agent_id, display_name, prompt are required' });
        return;
      }
      if (!Array.isArray(options) || options.length === 0) {
        res.status(400).json({ error: 'options (non-empty string array) is required' });
        return;
      }
      const result = store!.registerAndPrompt({
        agentId: agent_id,
        displayName: display_name,
        prompt,
        options,
      });
      if (!result.ok) {
        if (result.reason.startsWith('agent_id_in_use')) {
          res.status(409).json({ error: 'agent_id_in_use', message: 'This agent_id is already active on the Hub. Use a different agent_id or wait for the existing one to expire.', agent_id });
          return;
        }
        res.status(400).json({ error: result.reason });
        return;
      }
      notifyUiSse('prompt_created', { id: result.prompt_id, agent_id, superseded: 0 });
      res.json({ ok: true, agent_id, prompt_id: result.prompt_id });
    } catch (err) {
      ctx.logger.error({ err }, 'one-step register error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/ui/prompts', (req, res) => {
    try {
      const { prompt, options, agent_id } = req.body as {
        prompt?: string;
        options?: string[];
        agent_id?: string;
      };
      if (!prompt) {
        res.status(400).json({ error: 'prompt (string) required' });
        return;
      }
      if (!Array.isArray(options) || options.length === 0) {
        res.status(400).json({ error: 'options (non-empty string array) is required' });
        return;
      }
      const storedJson = JSON.stringify(options);
      const id = randomUUID();
      const now = new Date();

      // ── Hard constraint: an agent must wait for its existing pending prompt
      //    to be answered before creating a new one. This forces correct
      //    "ask once, wait forever" behavior at the protocol level.
      if (agent_id) {
        const existingChoices = db.select({ id: uiPrompts.id, createdAt: uiPrompts.createdAt })
          .from(uiPrompts)
          .where(and(eq(uiPrompts.agentId, agent_id), isNull(uiPrompts.answeredAt)))
          .all();
        if (existingChoices.length > 0) {
          const blocking = existingChoices[0];
          ctx.logger.warn(
            { agent_id, blocking_prompt_id: blocking?.id, attempted_prompt: prompt.slice(0, 80) },
            'prompt creation blocked — agent has unanswered prompt',
          );
          res.status(409).json({
            error: 'pending_choice_exists',
            message: 'Agent already has an unanswered prompt. Wait for the user to answer it before creating a new one.',
            blocking_prompt_id: blocking?.id ?? null,
            blocking_created_at: blocking?.createdAt ?? null,
          });
          return;
        }
      }

      db.insert(uiPrompts)
        .values({
          id,
          prompt,
          optionsJson: storedJson,
          answer: null,
          agentId: agent_id ?? null,
          createdAt: now,
          answeredAt: null,
        })
        .run();

      // 标记 Agent 为 blocked 状态
      if (agent_id) {
        db.update(sessions)
          .set({
            agentStatus: 'blocked',
            currentPromptId: id,
            blockedSince: now,
            updatedAt: now,
          })
          .where(eq(sessions.agentId, agent_id))
          .run();
        lastSupersedeTimes.set(agent_id, now.getTime());
      }

      notifyUiSse('prompt_created', { id, agent_id: agent_id ?? null, superseded: 0 });
      res.json({ id, state: 'pending', superseded: 0 });
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompt create error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ui/prompts', (_req, res) => {
    try {
      const rows = db
        .select()
        .from(uiPrompts)
        .where(isNull(uiPrompts.answeredAt))
        .all();
      const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))] as string[];
      const nameMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const sessRows = db.select().from(sessions).where(inArray(sessions.agentId, agentIds)).all();
        for (const s of sessRows) {
          if (s.displayName && s.agentId) nameMap[s.agentId] = s.displayName;
        }
      }
      res.json(
        rows.map((r) => {
          const parsed = JSON.parse(r.optionsJson);
          const options = Array.isArray(parsed) ? parsed : [];
          return {
            id: r.id,
            prompt: r.prompt,
            options,
            answer: r.answer,
            answered: !!r.answeredAt,
            agent_id: r.agentId,
            display_name: r.agentId ? nameMap[r.agentId] ?? null : null,
            created_at: r.createdAt,
          };
        }),
      );
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompts list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ui/prompts/history', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 200, 10000);
      const rows = db
        .select()
        .from(uiPrompts)
        .where(sql`${uiPrompts.answeredAt} IS NOT NULL`)
        .orderBy(sql`${uiPrompts.answeredAt} DESC`)
        .limit(limit)
        .all();
      const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))] as string[];
      const nameMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const sessRows = db.select().from(sessions).where(inArray(sessions.agentId, agentIds)).all();
        for (const s of sessRows) {
          if (s.displayName && s.agentId) nameMap[s.agentId] = s.displayName;
        }
      }
      res.json(
        rows.map((r) => {
          const parsed = JSON.parse(r.optionsJson);
          const options = Array.isArray(parsed) ? parsed : [];
          return {
            id: r.id,
            prompt: r.prompt,
            options,
            answer: r.answer,
            answered: !!r.answeredAt,
            agent_id: r.agentId,
            display_name: r.agentId ? nameMap[r.agentId] ?? null : null,
            created_at: r.createdAt,
            answered_at: r.answeredAt,
          };
        }),
      );
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompts history error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ui/prompts/:id', (req, res) => {
    try {
      const agentIdHeader = req.headers['x-agent-id'] as string | undefined;

      if (agentIdHeader) {
        const throttleKey = `${agentIdHeader}:${req.params.id}`;
        const now = Date.now();
        const last = promptPollLastHit.get(throttleKey);
        if (last && now - last < PROMPT_POLL_MIN_INTERVAL_MS) {
          res.status(429).json({ error: 'too_many_requests', retry_after_ms: PROMPT_POLL_MIN_INTERVAL_MS });
          return;
        }
        promptPollLastHit.set(throttleKey, now);

        if (now - lastPollThrottleCleanup > POLL_THROTTLE_CLEANUP_MS) {
          lastPollThrottleCleanup = now;
          for (const [k, t] of promptPollLastHit) {
            if (now - t > POLL_THROTTLE_CLEANUP_MS) promptPollLastHit.delete(k);
          }
          for (const [k, t] of lastSupersedeTimes) {
            if (now - t > POLL_THROTTLE_CLEANUP_MS) lastSupersedeTimes.delete(k);
          }
        }

        const pingResult = db.update(sessions)
          .set({ lastPingAt: new Date() })
          .where(eq(sessions.agentId, agentIdHeader))
          .run();
        if (pingResult.changes === 0) {
          ctx.logger.warn({ agentId: agentIdHeader }, 'heartbeat via X-Agent-Id matched no session');
        }
      }

      const row = db
        .select()
        .from(uiPrompts)
        .where(eq(uiPrompts.id, req.params.id))
        .get();
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Ownership guard: 多 Agent 并发时防止串台。
      // 仅在调用方明确带 X-Agent-Id 且 prompt 有 agentId 时校验；
      // Web UI 不带 header，仍可正常浏览所有 prompt。
      if (agentIdHeader && row.agentId && agentIdHeader !== row.agentId) {
        ctx.logger.warn(
          { requester: agentIdHeader, owner: row.agentId, prompt_id: req.params.id },
          'cross-agent prompt access blocked',
        );
        res.status(403).json({
          error: 'forbidden_cross_agent',
          message: 'X-Agent-Id does not own this prompt',
          owner_agent_id: row.agentId,
        });
        return;
      }

      const parsed = JSON.parse(row.optionsJson);
      const options = Array.isArray(parsed) ? parsed : [];
      const isSuperseded = row.answer === '[auto-closed: superseded by newer prompt]';

      let displayName: string | null = null;
      if (row.agentId) {
        const sess = db.select().from(sessions).where(eq(sessions.agentId, row.agentId)).get();
        if (sess?.displayName) displayName = sess.displayName;
      }

      res.json({
        id: row.id,
        prompt: row.prompt,
        options,
        answer: row.answer,
        answered: !!row.answeredAt,
        agent_id: row.agentId,
        display_name: displayName,
        created_at: row.createdAt,
        ...(isSuperseded && { superseded: true }),
      });
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompt get error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ui/prompts/:id/stream', (req, res) => {
    try {
      const agentId = (req.headers['x-agent-id'] as string) ?? (req.query.agent_id as string) ?? '';
      const promptId = req.params.id;

      const row = db.select().from(uiPrompts).where(eq(uiPrompts.id, promptId)).get();
      if (!row) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'not_found', prompt_id: promptId })}\n\n`);
        res.end();
        return;
      }

      // Ownership guard（同步语义）：SSE 也阻止跨 Agent 订阅。
      if (agentId && row.agentId && agentId !== row.agentId) {
        ctx.logger.warn(
          { requester: agentId, owner: row.agentId, prompt_id: promptId },
          'cross-agent prompt stream blocked',
        );
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.status(403);
        res.flushHeaders();
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: 'forbidden_cross_agent',
            message: 'X-Agent-Id does not own this prompt',
            owner_agent_id: row.agentId,
          })}\n\n`,
        );
        res.end();
        return;
      }

      if (row.answeredAt) {
        const isSuperseded = row.answer === '[auto-closed: superseded by newer prompt]';
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const ev = isSuperseded ? 'superseded' : 'answered';
        res.write(`event: ${ev}\ndata: ${JSON.stringify({ answer: row.answer })}\n\n`);
        res.end();
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      res.write('retry: 3000\n\n');
      res.write(': connected\n\n');

      const client: PromptSseClient = { res, agentId };
      if (!promptSseClients.has(promptId)) promptSseClients.set(promptId, new Set());
      promptSseClients.get(promptId)!.add(client);

      req.on('close', () => {
        const set = promptSseClients.get(promptId);
        if (set) { set.delete(client); if (set.size === 0) promptSseClients.delete(promptId); }
      });
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompt stream error');
      if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/ui/prompts/:id/answer', (req, res) => {
    try {
      const { answer } = req.body as { answer?: string };
      if (!answer) {
        res.status(400).json({ error: 'answer required' });
        return;
      }
      const row = db
        .select()
        .from(uiPrompts)
        .where(eq(uiPrompts.id, req.params.id))
        .get();
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      if (row.answeredAt) {
        res.status(409).json({ error: 'already_answered', answer: row.answer });
        return;
      }
      db.update(uiPrompts)
        .set({ answer, answeredAt: new Date() })
        .where(eq(uiPrompts.id, req.params.id))
        .run();

      // 解除 Agent 阻塞状态
      if (row.agentId) {
        db.update(sessions)
          .set({
            agentStatus: 'active',
            currentPromptId: null,
            blockedSince: null,
            updatedAt: new Date(),
          })
          .where(eq(sessions.agentId, row.agentId))
          .run();
      }

      notifyPromptSseClients(req.params.id, 'answered', { answer });
      notifyUiSse('prompt_answered', { id: req.params.id, agent_id: row.agentId ?? null });
      res.json({ id: row.id, answer, state: 'answered' });
    } catch (err) {
      ctx.logger.error({ err }, 'ui prompt answer error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/ui/health', (_req, res) => {
    res.json({ status: 'ok', service: 'polarcopilot-hub', uptime: process.uptime() });
  });

  // ── Global UI SSE stream ─────────────────────────────────────────
  app.get('/api/ui/stream', (_req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(': connected\n\n');
    uiSseClients.add(res);
    const hb = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(hb); uiSseClients.delete(res); }
    }, 30_000);
    _req.on('close', () => { clearInterval(hb); uiSseClients.delete(res); });
  });

  // ── Alignment API (YOLO 对齐文档) ─────────────────────────────────

  const REQUIRED_ALIGNMENT_SECTIONS = [
    '极限目标', '工作逻辑', '用户预期体验', '执行计划', '质量标准', '工作流测试矩阵', '风险',
  ] as const;

  const ALIGNMENT_DIMENSIONS = ['极限目标', '工作逻辑', '用户预期体验'] as const;

  interface AlignmentCoverage {
    score: number;
    total: number;
    covered: number;
    sections: Array<{ name: string; present: boolean; hasContent: boolean }>;
    requirement_refs: Array<{ ref: string; task_linked: boolean }>;
    dimensions: Array<{ name: string; covered: boolean; reason: string }>;
    errors: string[];
    warnings: string[];
  }

  function computeAlignmentCoverage(planMarkdown: string, goal: string, workflowsJson: string, sectionsJson: string): AlignmentCoverage {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Check each required section exists in plan_markdown with non-trivial content
    const sectionResults = REQUIRED_ALIGNMENT_SECTIONS.map(name => {
      const headerPattern = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
      const present = headerPattern.test(planMarkdown);
      let hasContent = false;
      if (present) {
        const sectionMatch = planMarkdown.match(new RegExp(
          `^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=^##\\s|$(?!\\n))`, 'm'
        ));
        const content = sectionMatch?.[1]?.trim() ?? '';
        hasContent = content.length > 10;
      }
      if (!present) errors.push(`缺少必要 section: ## ${name}`);
      else if (!hasContent) warnings.push(`section "## ${name}" 内容不足（需要 > 10 字符）`);
      return { name, present, hasContent };
    });

    // 2. Optional task references in plan (e.g. [Task:...] or bullet IDs)
    const reqRefs: Array<{ ref: string; task_linked: boolean }> = [];
    const taskRefPattern = /\[(?:Task|REQ):([^\]]+)\]/gi;
    let match;
    while ((match = taskRefPattern.exec(planMarkdown)) !== null) {
      reqRefs.push({ ref: match[1]!, task_linked: true });
    }

    // 3. Check three alignment dimensions
    const workflows = (() => { try { return JSON.parse(workflowsJson); } catch { return []; } })() as unknown[];
    const dimensions = ALIGNMENT_DIMENSIONS.map(dim => {
      let covered = false;
      let reason = '';
      if (dim === '极限目标') {
        covered = typeof goal === 'string' && goal.trim().length > 10;
        reason = covered ? 'goal 字段已填写' : 'goal 字段为空或过短（需 > 10 字符）';
      } else if (dim === '工作逻辑') {
        const hasSection = sectionResults.find(s => s.name === '工作逻辑');
        covered = !!(hasSection?.present && hasSection?.hasContent);
        reason = covered ? 'plan_markdown 包含工作逻辑 section' : '缺少工作逻辑 section 或内容不足';
      } else if (dim === '用户预期体验') {
        const hasSection = sectionResults.find(s => s.name === '用户预期体验');
        const hasWorkflows = Array.isArray(workflows) && workflows.length > 0;
        covered = !!(hasSection?.present && hasSection?.hasContent) || hasWorkflows;
        reason = covered ? '已定义用户工作流' : '缺少用户预期体验 section 且 workflows 为空';
      }
      if (!covered) errors.push(`三维对齐未覆盖: ${dim} — ${reason}`);
      return { name: dim, covered, reason };
    });

    // 4. Compute score
    const checkpoints = [
      ...sectionResults.map(s => (s.present && s.hasContent) ? 1 : 0),
      ...dimensions.map(d => d.covered ? 1 : 0),
      reqRefs.length > 0 ? 1 : 0,
      reqRefs.every(r => r.task_linked) ? 1 : 0,
      (typeof goal === 'string' && goal.trim().length > 10) ? 1 : 0,
    ];
    const total = checkpoints.length;
    const covered = checkpoints.reduce((a, b) => a + b, 0);

    return { score: Math.round((covered / total) * 100), total, covered, sections: sectionResults, requirement_refs: reqRefs, dimensions, errors, warnings };
  }

  app.post('/api/ui/alignment', (req, res) => {
    try {
      const { agent_id, goal, work_logic, workflows, plan_markdown, sections, status: reqStatus } = req.body;

      // Draft docs from UI skip strict validation (user initiating YOLO, agent will fill content later)
      const isDraft = !reqStatus || reqStatus === 'draft';
      const skipValidation = isDraft && !plan_markdown;

      if (!skipValidation) {
        const validationErrors: string[] = [];
        if (!goal || (typeof goal === 'string' && goal.trim().length < 10)) {
          validationErrors.push('goal 必须非空且至少 10 字符（极限目标不能为空）');
        }
        if (!plan_markdown || (typeof plan_markdown === 'string' && plan_markdown.trim().length < 50)) {
          validationErrors.push('plan_markdown 必须非空且至少 50 字符（对齐方案不能为空）');
        }

        const providedSections = Array.isArray(sections) ? sections as Array<{ name: string }> : [];
        const missingSections = REQUIRED_ALIGNMENT_SECTIONS.filter(
          req => !providedSections.some(s => s.name === req)
        );
        if (missingSections.length > 0) {
          validationErrors.push(`sections 缺少必要项: ${missingSections.join(', ')}（需要全部 7 个 section）`);
        }

        if (validationErrors.length > 0) {
          return res.status(400).json({
            error: 'alignment_validation_failed',
            message: 'YOLO 对齐文档未通过验证，请补充必要内容后重试',
            validation_errors: validationErrors,
          });
        }
      }

      const coverage = computeAlignmentCoverage(
        plan_markdown || '', goal || '',
        JSON.stringify(workflows || []), JSON.stringify(sections || [])
      );

      const id = randomUUID();
      const now = new Date();
      db.insert(alignmentDocs).values({
        id,
        agentId: agent_id || 'unknown',
        status: 'draft',
        goal: goal || '',
        workLogic: work_logic || 'Debug > Test > Dev',
        workflowsJson: JSON.stringify(workflows || []),
        planMarkdown: plan_markdown || '',
        sectionsJson: JSON.stringify(sections || []),
        version: 1,
        createdAt: now,
        updatedAt: now,
      }).run();
      res.json({ id, status: 'draft', version: 1, coverage });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/ui/alignment', (req, res) => {
    try {
      const statusFilter = req.query.status as string | undefined;
      let rows;
      if (statusFilter) {
        rows = db.select().from(alignmentDocs).where(eq(alignmentDocs.status, statusFilter)).all();
      } else {
        rows = db.select().from(alignmentDocs).all();
      }
      res.json(rows.map(r => ({
        id: r.id,
        agent_id: r.agentId,
        status: r.status,
        goal: r.goal,
        work_logic: r.workLogic,
        workflows: JSON.parse(r.workflowsJson),
        plan_markdown: r.planMarkdown,
        sections: JSON.parse(r.sectionsJson),
        version: r.version,
        created_at: r.createdAt?.toISOString(),
        updated_at: r.updatedAt?.toISOString(),
        approved_at: r.approvedAt?.toISOString() ?? null,
        completed_at: r.completedAt?.toISOString() ?? null,
      })));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/ui/alignment/:id', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });
      res.json({
        id: row.id,
        agent_id: row.agentId,
        status: row.status,
        goal: row.goal,
        work_logic: row.workLogic,
        workflows: JSON.parse(row.workflowsJson),
        plan_markdown: row.planMarkdown,
        sections: JSON.parse(row.sectionsJson),
        version: row.version,
        created_at: row.createdAt?.toISOString(),
        updated_at: row.updatedAt?.toISOString(),
        approved_at: row.approvedAt?.toISOString() ?? null,
        completed_at: row.completedAt?.toISOString() ?? null,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/ui/alignment/:id/coverage', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const coverage = computeAlignmentCoverage(row.planMarkdown, row.goal, row.workflowsJson, row.sectionsJson);
      res.json({ id: row.id, status: row.status, coverage });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.patch('/api/ui/alignment/:id', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };
      if (req.body.goal !== undefined) updates.goal = req.body.goal;
      if (req.body.work_logic !== undefined) updates.workLogic = req.body.work_logic;
      if (req.body.workflows !== undefined) updates.workflowsJson = JSON.stringify(req.body.workflows);
      if (req.body.plan_markdown !== undefined) updates.planMarkdown = req.body.plan_markdown;
      if (req.body.sections !== undefined) updates.sectionsJson = JSON.stringify(req.body.sections);
      if (req.body.status !== undefined) updates.status = req.body.status;

      const newVersion = row.version + 1;
      updates.version = newVersion;

      // Save version history
      db.insert(alignmentVersions).values({
        id: randomUUID(),
        alignmentId: row.id,
        version: row.version,
        planMarkdown: row.planMarkdown,
        sectionsJson: row.sectionsJson,
        changedBy: req.body.changed_by || row.agentId,
        createdAt: now,
      }).run();

      db.update(alignmentDocs).set(updates).where(eq(alignmentDocs.id, req.params.id)).run();
      notifyUiSse('alignment_updated', { id: req.params.id, status: updates.status ?? row.status, version: newVersion });
      res.json({ ok: true, version: newVersion });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/ui/alignment/:id/confirm-section', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const { section_name, confirmed, comment } = req.body;
      const sections = JSON.parse(row.sectionsJson) as Array<{ name: string; confirmed: boolean; comment?: string }>;
      const idx = sections.findIndex(s => s.name === section_name);
      if (idx >= 0) {
        const sec = sections[idx]!;
        sec.confirmed = confirmed !== false;
        if (comment) sec.comment = comment;
      } else {
        sections.push({ name: section_name, confirmed: confirmed !== false, comment });
      }

      const now = new Date();
      db.update(alignmentDocs).set({
        sectionsJson: JSON.stringify(sections),
        updatedAt: now,
      }).where(eq(alignmentDocs.id, req.params.id)).run();

      const allConfirmed = sections.length > 0 && sections.every(s => s.confirmed);
      res.json({ ok: true, sections, all_confirmed: allConfirmed });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/ui/alignment/:id/approve', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const sections = JSON.parse(row.sectionsJson) as Array<{ name: string; confirmed: boolean }>;
      const allConfirmed = sections.length > 0 && sections.every(s => s.confirmed);
      if (!allConfirmed && !req.body.force) {
        return res.status(400).json({ error: 'not all sections confirmed', sections });
      }

      const coverage = computeAlignmentCoverage(row.planMarkdown, row.goal, row.workflowsJson, row.sectionsJson);
      const dimensionsCovered = coverage.dimensions.every(d => d.covered);
      if (!dimensionsCovered && !req.body.force) {
        return res.status(400).json({
          error: 'alignment_coverage_insufficient',
          message: '三维对齐未完全覆盖，不能批准执行',
          coverage,
        });
      }
      if (coverage.score < 60 && !req.body.force) {
        return res.status(400).json({
          error: 'alignment_coverage_low',
          message: `覆盖率 ${coverage.score}% 不足（最低要求 60%），请补充对齐内容`,
          coverage,
        });
      }

      const now = new Date();
      db.update(alignmentDocs).set({
        status: 'executing',
        approvedAt: now,
        updatedAt: now,
      }).where(eq(alignmentDocs.id, req.params.id)).run();

      notifyUiSse('alignment_updated', { id: req.params.id, status: 'executing', agent_id: row.agentId });

      // Auto-answer the Agent's pending prompt so it starts YOLO execution
      if (row.agentId) {
        const pendingPrompt = db.select().from(uiPrompts)
          .where(and(eq(uiPrompts.agentId, row.agentId), isNull(uiPrompts.answeredAt)))
          .get();
        if (pendingPrompt) {
          db.update(uiPrompts)
            .set({ answer: '确认，开始 YOLO', answeredAt: now })
            .where(eq(uiPrompts.id, pendingPrompt.id))
            .run();
          notifyPromptSseClients(pendingPrompt.id, 'answered', { answer: '确认，开始 YOLO' });
          notifyUiSse('prompt_answered', { id: pendingPrompt.id, agent_id: row.agentId });
        }
      }

      res.json({ ok: true, status: 'executing' });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/ui/alignment/:id/complete', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const now = new Date();
      db.update(alignmentDocs).set({
        status: 'completed',
        completedAt: now,
        updatedAt: now,
      }).where(eq(alignmentDocs.id, req.params.id)).run();

      notifyUiSse('alignment_updated', { id: req.params.id, status: 'completed', agent_id: row.agentId });
      res.json({ ok: true, status: 'completed', summary: req.body.summary });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.post('/api/ui/alignment/:id/reject', (req, res) => {
    try {
      const row = db.select().from(alignmentDocs).where(eq(alignmentDocs.id, req.params.id)).get();
      if (!row) return res.status(404).json({ error: 'not found' });

      const now = new Date();
      db.update(alignmentDocs).set({
        status: 'rejected',
        updatedAt: now,
      }).where(eq(alignmentDocs.id, req.params.id)).run();

      notifyUiSse('alignment_updated', { id: req.params.id, status: 'rejected', agent_id: row.agentId });
      res.json({ ok: true, status: 'rejected', comment: req.body.comment });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/ui/alignment/:id/versions', (req, res) => {
    try {
      const rows = db.select().from(alignmentVersions)
        .where(eq(alignmentVersions.alignmentId, req.params.id))
        .all();
      res.json(rows.map(r => ({
        id: r.id,
        version: r.version,
        plan_markdown: r.planMarkdown,
        sections: JSON.parse(r.sectionsJson),
        changed_by: r.changedBy,
        created_at: r.createdAt?.toISOString(),
      })));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });

  const UI_TO_PC: Record<string, string> = {
    '/ui': '/pc/prompts',
    '/ui/prompts': '/pc/prompts',
    '/ui/yolo': '/pc/yolo',
  };
  for (const [from, to] of Object.entries(UI_TO_PC)) {
    app.get(from, (_req, res) => { res.redirect(301, to); });
  }

  // ── Web SPA (/pc/*) ────────────────────────────────────────────────
  const pcProjectDir = (process.env.PC_PROJECT_DIR ?? '').trim();
  const pcWebCandidates = [
    pcProjectDir ? join(pcProjectDir, 'web', 'dist') : '',
    join(process.cwd(), '..', 'web', 'dist'),
  ].filter(Boolean);
  const pcWebDist = pcWebCandidates.find((p) => existsSync(p)) ?? '';
  const readmeImageDirs = [
    pcProjectDir ? join(pcProjectDir, 'docs', 'images') : '',
    pcProjectDir ? join(pcProjectDir, 'web', 'dist', 'readme') : '',
    pcProjectDir ? join(pcProjectDir, 'web', 'public', 'readme') : '',
  ].filter((p) => p && existsSync(p));
  const readmeImagesDir = readmeImageDirs[0] ?? '';
  if (readmeImagesDir) {
    app.use('/pc/readme', express.static(readmeImagesDir, { maxAge: '1h' }));
  }
  if (pcWebDist && existsSync(pcWebDist)) {
    app.use('/pc', express.static(pcWebDist, { etag: false, lastModified: false, maxAge: 0 }));
    // SPA fallback — exclude /pc/readme/* so README 截图可直链访问
    app.get(/^\/pc\/(?!readme\/).+/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(pcWebDist, 'index.html'));
    });
    app.get('/', (_req, res) => { res.redirect(302, '/pc/prompts'); });
  }
}

export function createStandaloneApp(
  app: Express,
  deps: {
    hubDb: HubDb;
    ctx: HubContext;
    publisher?: BroadcastPublisher;
    store?: HubStore;
  },
): void {
  mountStandaloneRoutes(app, deps.hubDb, deps.ctx, deps.publisher, deps.store);
}

export function createHubExpress(): Express {
  const app = express();
  app.set("etag", false);
  app.use(express.json({ limit: "10mb" }));
  app.use(localhostHostValidation());
  return app;
}
