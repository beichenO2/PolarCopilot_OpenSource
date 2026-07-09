import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname } from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import multer from 'multer';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ALIVE_THRESHOLD_MS as ALIVE_THRESHOLD_MS_CONST } from '../constants.js';
import type { BroadcastPublisher } from '../broadcast/publisher.js';
import type { SseHub } from '../broadcast/sse-hub.js';
import type { EventSubscriber } from '../broadcast/subscriber.js';
import { loadConfigFromDisk, updateConfigOnDisk } from '../config/loader.js';
import {
  hubPollEventsInputSchema,
  hubPublishInputSchema,
  hubSubscribeInputSchema,
} from '../protocol/broadcast.js';
import { hubStateReadInputSchema, hubStateWriteInputSchema } from '../protocol/state.js';
import {
  hubClaimTaskInputSchema,
  hubCompleteTaskInputSchema,
  hubCreateTaskInputSchema,
  hubListTasksInputSchema,
  hubSplitTaskInputSchema,
} from '../protocol/tasks.js';
import { hubGetConfigInputSchema, hubUpdateConfigInputSchema } from '../protocol/config.js';
import {
  hubAcquireLeaseInputSchema,
  hubCheckLeaseInputSchema,
  hubReleaseLeaseInputSchema,
} from '../protocol/leases.js';
import type { HubAcquireLeaseOutput } from '../protocol/leases.js';
import {
  hubCheckpointInputSchema,
  hubHandoffInputSchema,
  hubReportProgressInputSchema,
  hubRequestHelpInputSchema,
} from '../protocol/agent.js';
import {
  hubSubmitQuestionInputSchema,
  hubClaimQuestionInputSchema,
  hubSubmitAnswerInputSchema,
  hubSubmitEscalationInputSchema,
  hubResolveEscalationInputSchema,
  hubGetContextRefInputSchema,
} from '../protocol/questions.js';
import type { PathLeaseService } from '../persistence/path-leases.js';
import type { HubContext } from '../types.js';
import { HubStore } from '../persistence/store.js';
import { SessionRegistry } from '../session/registry.js';
import {
  hubGetAuditLogInputSchema,
  hubGetHealthInputSchema,
  hubGetProgressInputSchema,
  hubSetLimitsInputSchema,
} from '../protocol/safety.js';
import type { HubDb } from '../persistence/db.js';
import { sessions, agentCapabilities, uiPrompts, agentRoles, events, tasks, taskDependencies, alignmentDocs, alignmentVersions, projectOwnership, sotadiffEntries, pathLeases, prolusionPlans, p22Alerts } from '../persistence/db.js';
import { eq, inArray, isNull, sql, and, gt, lte, ne } from 'drizzle-orm';
import type { AuditJournal } from '../safety/audit.js';
import { buildHealthStatus } from '../safety/health.js';
import { buildProgressByPhase } from '../safety/progress.js';
import type { SafetyLimiter } from '../safety/limiter.js';
import type { ModuleAffinityService } from '../tasks/affinity.js';
import { readAgentCheckpoint, writeAgentCheckpoint } from '../tasks/checkpoint.js';
import { ProgressTracker } from '../tasks/progress.js';
import type { TaskService } from '../tasks/service.js';
import type { QuestionService } from '../questions/service.js';
import { hubSotaDiffRecordInputSchema } from '../protocol/sotadiff.js';

const hubBlockTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
});

const hubCancelTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
});

export type StreamableHttpHub = {
  app: Express;
  transports: Record<string, StreamableHTTPServerTransport>;
};

function createMcpServerForHub(deps: {
  store: HubStore;
  registry: SessionRegistry;
  ctx: HubContext;
  publisher: BroadcastPublisher;
  eventSubscriber: EventSubscriber;
  mirrorRoot: string;
  taskService: TaskService;
  pathLeaseService: PathLeaseService;
  progressTracker: ProgressTracker;
  safetyLimiter: SafetyLimiter;
  auditJournal: AuditJournal;
  hubDb: HubDb;
  moduleAffinityService?: ModuleAffinityService;
  lifecycleTracker?: import('../lifecycle/tracker.js').LifecycleTracker;
  questionService?: QuestionService;
  roleManager?: import('../roles/manager.js').RoleManager;
  clkService?: import('../roles/clk.js').ClkService;
}): McpServer {
  const {
    store,
    registry,
    ctx,
    publisher,
    eventSubscriber,
    mirrorRoot,
    taskService,
    pathLeaseService,
    progressTracker,
    safetyLimiter,
    auditJournal,
    hubDb,
    moduleAffinityService,
    questionService,
    roleManager,
    clkService,
  } = deps;
  const server = new McpServer({
    name: 'polarcop-hub',
    version: '0.1.0',
  });

  server.registerTool(
    'hub_register',
    {
      description: 'Register or refresh this MCP session with a stable agent_id (reconnect updates mcp session binding).',
      inputSchema: {
        agent_id: z.string().min(1).max(256).describe('Stable agent identifier for routing and audit'),
        label: z.string().max(512).optional().describe('Optional human-readable label'),
        display_name: z.string().max(256).optional().describe('Human-readable display name shown in UI (set atomically with registration)'),
        agent_type: z.enum(['solo', 'slave']).optional().describe('Agent type for UI grouping'),
        roles: z.array(z.string()).max(200).optional().describe('Optional capability roles'),
        skills: z.array(z.string()).max(500).optional().describe('Optional capability skills'),
        owned_modules: z.array(z.string().min(1)).max(50).optional().describe('Modules this agent is responsible for (memory affinity)'),
      },
    },
    async ({ agent_id, label, display_name, agent_type, roles, skills, owned_modules }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const result = registry.register(sessionId, agent_id, label ?? null);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: false, error: 'register_rejected', reason: result.reason }),
            },
          ],
          isError: true,
        };
      }
      ctx.logger.info({ agent_id, session_id: sessionId }, 'hub_register');

      if (display_name || agent_type) {
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (display_name) updates.displayName = display_name;
        if (agent_type) updates.agentType = agent_type;
        hubDb.update(sessions).set(updates).where(eq(sessions.agentId, agent_id)).run();
      }

      store.initEventCursorIfMissing(agent_id);
      safetyLimiter.ensureTracked(agent_id);
      if (deps.lifecycleTracker) {
        const primaryRole = roles?.[0] ?? label ?? 'unknown';
        deps.lifecycleTracker.registerAgent(agent_id, primaryRole);
      }
      if ((roles?.length ?? 0) > 0 || (skills?.length ?? 0) > 0) {
        registry.saveCapabilities(agent_id, roles ?? [], skills ?? []);
      }
      if (moduleAffinityService && owned_modules && owned_modules.length > 0) {
        moduleAffinityService.declareOwnership(agent_id, owned_modules);
      }
      auditJournal.append({
        agentId: agent_id,
        taskId: null,
        action: 'hub.register',
        details: {
          label: label ?? null,
          roles: roles?.length ?? 0,
          skills: skills?.length ?? 0,
          owned_modules: owned_modules ?? [],
        },
        correlationId: null,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              agent_id,
              session_id: sessionId,
            }),
          },
        ],
      };
    },
  );

  /**
   * hub_claim_id — Claim a unique agent_id at startup.
   *
   * - If the requested agent_id is already held by a *different* MCP session,
   *   the old session is wiped (displayName cleared, parentAgentId cleared)
   *   and the id is granted to the caller.
   * - If the id is free, it is inserted fresh.
   * - If the id is already held by the *same* MCP session, it is a no-op (idempotent).
   *
   * This replaces the heartbeat-based collision detection with an explicit
   * "claim-at-startup + wipe-previous-owner" model.
   */
  server.registerTool(
    'hub_claim_id',
    {
      description: 'Claim a unique agent_id at startup. Wipes any previous holder of the same id so the caller becomes the sole owner.',
      inputSchema: {
        agent_id: z.string().min(1).max(256).describe('Stable agent identifier to claim'),
      },
    },
    async ({ agent_id }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }

      const now = Date.now();

      // Check if this mcpSessionId already owns this id (re-registration — no-op)
      const existingForSession = hubDb
        .select()
        .from(sessions)
        .where(and(eq(sessions.mcpSessionId, sessionId), eq(sessions.agentId, agent_id)))
        .get();

      if (existingForSession) {
        // Same session re-claiming same id — just touch updatedAt
        hubDb.update(sessions)
          .set({ updatedAt: new Date(now) })
          .where(and(eq(sessions.mcpSessionId, sessionId), eq(sessions.agentId, agent_id)))
          .run();
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, agent_id, status: 'already_owned' }) }],
        };
      }

      // Wipe any previous holder of this agent_id (different mcpSessionId)
      hubDb.update(sessions)
        .set({ displayName: null, parentAgentId: null, updatedAt: new Date(now) })
        .where(eq(sessions.agentId, agent_id))
        .run();

      // Insert or re-bind for this session
      const bound = hubDb
        .select()
        .from(sessions)
        .where(eq(sessions.mcpSessionId, sessionId))
        .get();

      if (bound) {
        // This mcpSessionId has a different agent_id — replace it
        hubDb
          .update(sessions)
          .set({ agentId: agent_id, label: null, updatedAt: new Date(now) })
          .where(eq(sessions.mcpSessionId, sessionId))
          .run();
      } else {
        hubDb
          .insert(sessions)
          .values({ mcpSessionId: sessionId, agentId: agent_id, createdAt: new Date(now), updatedAt: new Date(now) })
          .run();
      }

      store.initEventCursorIfMissing(agent_id);
      safetyLimiter.ensureTracked(agent_id);

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, agent_id, status: 'claimed' }) }],
      };
    },
  );

  server.registerTool(
    'hub_status',
    {
      description: 'Return hub health, session stats, and pending durable messages for the calling agent.',
      inputSchema: {
        include_payloads: z.boolean().optional().describe('Include full pending message payloads (default true)'),
      },
    },
    async ({ include_payloads }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered', hint: 'call hub_register first' }) }],
          isError: true,
        };
      }
      const pending = store.listPendingMessages(row.agentId);
      const show = include_payloads !== false;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              hub: {
                started_at: ctx.hubStartedAt.toISOString(),
                registered_sessions: store.countSessions(),
              },
              session: {
                agent_id: row.agentId,
                session_id: sessionId,
                label: row.label,
              },
              lifecycle: deps.lifecycleTracker?.getMetrics(row.agentId) ?? null,
              pending_messages: pending.map((m) =>
                show
                  ? { id: m.id, created_at: m.createdAt.toISOString(), payload: m.payload }
                  : { id: m.id, created_at: m.createdAt.toISOString() },
              ),
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_ping',
    {
      description: 'Heartbeat and optional ack of consumed durable message ids.',
      inputSchema: {
        ack_message_ids: z.array(z.string()).max(500).optional().describe('Mark these message ids as consumed for this agent'),
      },
    },
    async ({ ack_message_ids }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      let touched = 0;
      if (ack_message_ids?.length) {
        touched = store.consumeMessages(row.agentId, ack_message_ids);
      }
      const ping = store.recordPing(sessionId);
      if (!ping.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'ping_failed' }) }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              agent_id: row.agentId,
              session_id: sessionId,
              server_time: new Date().toISOString(),
              acked: touched,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_subscribe',
    {
      description: 'Restrict durable broadcast / SSE delivery to topic filters for this agent (empty = all topics).',
      inputSchema: hubSubscribeInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubSubscribeInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      eventSubscriber.setSubscription(parsed.data.agent_id, parsed.data.topics);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              subscription: { agent_id: parsed.data.agent_id, topics: parsed.data.topics },
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_publish',
    {
      description: 'Publish a durable hub event (persisted + SSE fan-out + poll cursor).',
      inputSchema: hubPublishInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubPublishInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      store.recordPing(sessionId);
      const out = publisher.publish({
        sourceAgentId: parsed.data.agent_id,
        topic: parsed.data.topic,
        payload: parsed.data.payload,
        idempotencyKey: parsed.data.idempotency_key,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              event: {
                ...out.event,
                timestamp: out.event.timestamp.toISOString(),
              },
              deduplicated: out.deduplicated,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_poll_events',
    {
      description: 'Fetch durable broadcast events after cursor / event id (poll fallback when SSE is unavailable).',
      inputSchema: hubPollEventsInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubPollEventsInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      const limit = Math.min(parsed.data.limit ?? 100, 500);
      let exclusiveSeq = store.getEventCursor(parsed.data.agent_id);
      if (parsed.data.after_event_id) {
        const seq = store.getBroadcastEventSequenceById(parsed.data.after_event_id);
        if (seq !== undefined) {
          exclusiveSeq = Math.max(exclusiveSeq, seq);
        }
      }
      store.recordPing(sessionId);
      const agentId = parsed.data.agent_id;
      const agentInbox = `${agentId}.inbox`;
      const batch = store.listEventsForAgent(exclusiveSeq, agentInbox, limit);
      const mapped = batch.map((r) => ({
        id: r.id,
        agent_id: r.sourceAgentId,
        topic: r.topic,
        payload: r.payload,
        timestamp: r.createdAt.toISOString(),
      }));
      let cursor: string | undefined;
      const lastEvent = batch.length > 0 ? batch[batch.length - 1] : undefined;
      if (lastEvent) {
        cursor = lastEvent.id;
        if (!parsed.data.peek) {
          store.upsertEventCursor(parsed.data.agent_id, lastEvent.sequenceNumber);
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              events: mapped,
              cursor,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_state_read',
    {
      description: 'Read a versioned planning document from hub durable state.',
      inputSchema: hubStateReadInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubStateReadInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      const doc = store.getPlanningDocument(parsed.data.path);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              document: doc
                ? {
                    ...doc,
                    updated_at: doc.updated_at.toISOString(),
                  }
                : null,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_state_write',
    {
      description: 'Optimistic concurrency write for versioned planning documents (mirrored to workspace when under mirrorRoot).',
      inputSchema: hubStateWriteInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubStateWriteInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.updated_by !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'updated_by_mismatch' }) }],
          isError: true,
        };
      }
      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const cached = store.getIdempotencyResult(parsed.data.idempotency_key);
        if (cached && typeof cached === 'object' && cached !== null && 'result' in cached) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ ok: true, result: (cached as { result: unknown }).result }),
              },
            ],
          };
        }
      }
      const result = store.writePlanningDocument({
        path: parsed.data.path,
        content: parsed.data.content,
        expectedVersion: parsed.data.expected_version,
        updatedBy: parsed.data.updated_by,
        mirrorRoot,
      });
      if (parsed.data.idempotency_key && result.status === 'success') {
        store.setIdempotencyResult(parsed.data.idempotency_key, { result }, IDEMP_TTL_MS);
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, result }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_create_task',
    {
      description: 'Create a schedulable task with optional dependencies and parent linkage.',
      inputSchema: hubCreateTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubCreateTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.creator_agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'creator_agent_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const out = taskService.createTask(parsed.data);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task: out.task }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'create_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_claim_task',
    {
      description: 'Claim the next ready task (dependency-resolved) with a time-bounded lease.',
      inputSchema: hubClaimTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubClaimTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const out = taskService.claimTask(parsed.data);
        const body: Record<string, unknown> = { ok: true, task: out.task };
        if (out.scheduling_hint) {
          body.scheduling_hint = out.scheduling_hint;
        }
        return { content: [{ type: 'text', text: JSON.stringify(body) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'claim_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_complete_task',
    {
      description: 'Mark a claimed task done and potentially auto-complete parents when all children are done.',
      inputSchema: hubCompleteTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubCompleteTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const out = taskService.completeTask(parsed.data);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task: out.task }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'complete_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_block_task',
    {
      description: 'Mark a task blocked and release any lease.',
      inputSchema: hubBlockTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubBlockTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const task = taskService.blockTask(parsed.data.agent_id, parsed.data.task_id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'block_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_cancel_task',
    {
      description: 'Cancel a task and release any lease.',
      inputSchema: hubCancelTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubCancelTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const task = taskService.cancelTask(parsed.data.agent_id, parsed.data.task_id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, task }) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'cancel_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_list_tasks',
    {
      description: 'List tasks with optional filters (including ready_only for dependency-resolved open work).',
      inputSchema: hubListTasksInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubListTasksInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      const out = taskService.listTasks(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tasks: out.tasks }) }] };
    },
  );

  server.registerTool(
    'hub_split_task',
    {
      description: 'Split a parent task into child tasks tracked under the same parent_task_id.',
      inputSchema: hubSplitTaskInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubSplitTaskInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      try {
        const out = taskService.splitTask(parsed.data);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, parent: out.parent, children: out.children }) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: false,
                error: err instanceof Error ? err.message : 'split_failed',
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_acquire_lease',
    {
      description: 'Acquire an exclusive path lease (writer lock) with TTL.',
      inputSchema: hubAcquireLeaseInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubAcquireLeaseInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const hit = store.getIdempotencyResult(parsed.data.idempotency_key);
        const revived = reviveAcquireLease(hit);
        if (revived) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ ok: true, ...serializeAcquireLease(revived) }) }],
          };
        }
      }

      const cfg = loadConfigFromDisk(mirrorRoot);
      const ttl = parsed.data.ttl_ms ?? cfg.default_lease_ttl_ms ?? 600_000;
      const out = pathLeaseService.acquire({
        agentId: parsed.data.agent_id,
        path: parsed.data.path,
        ttlMs: ttl,
      });

      if (parsed.data.idempotency_key) {
        store.setIdempotencyResult(parsed.data.idempotency_key, serializeAcquireLease(out), IDEMP_TTL_MS);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...serializeAcquireLease(out) }) }] };
    },
  );

  server.registerTool(
    'hub_release_lease',
    {
      description: 'Release a path lease by lease_id or path (must match agent_id).',
      inputSchema: hubReleaseLeaseInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubReleaseLeaseInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const hit = store.getIdempotencyResult(parsed.data.idempotency_key);
        if (typeof hit === 'boolean') {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, released: hit }) }] };
        }
      }

      const released = pathLeaseService.release({
        agentId: parsed.data.agent_id,
        leaseId: parsed.data.lease_id,
        path: parsed.data.path,
      });

      if (parsed.data.idempotency_key) {
        store.setIdempotencyResult(parsed.data.idempotency_key, released, IDEMP_TTL_MS);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, released }) }] };
    },
  );

  server.registerTool(
    'hub_check_lease',
    {
      description: 'Return the active exclusive lease for a path, if any.',
      inputSchema: hubCheckLeaseInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubCheckLeaseInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      const lease = pathLeaseService.check(parsed.data.path);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              lease: lease
                ? {
                    ...lease,
                    expires_at: lease.expires_at.toISOString(),
                    created_at: lease.created_at.toISOString(),
                  }
                : null,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_register_ownership',
    {
      description: 'Register this agent as the owner of a project. Call once at startup after hub_register. Ownership is used by the cross-project write protocol (Protocol H) to route XPCP requests to the correct agent.',
      inputSchema: {
        agent_id: z.string().min(1).describe('Agent ID (must match registered session)'),
        project_name: z.string().min(1).describe('Short project name, e.g. "PolarClaw", "PolarCopilot"'),
        project_path: z.string().optional().describe('Absolute path to the project root'),
      },
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      }
      const { agent_id, project_name, project_path } = raw as { agent_id: string; project_name: string; project_path?: string };
      if (!agent_id || !project_name) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }], isError: true };
      }
      if (agent_id !== row.agentId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }], isError: true };
      }
      const now = new Date();
      hubDb.insert(projectOwnership).values({
        projectName: project_name,
        agentId: agent_id,
        projectPath: project_path ?? '',
        registeredAt: now,
      }).onConflictDoUpdate({
        target: projectOwnership.projectName,
        set: { agentId: agent_id, projectPath: project_path ?? '', registeredAt: now },
      }).run();
      ctx.logger.info({ agent_id, project_name }, 'hub_register_ownership');
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, project_name, agent_id }) }] };
    },
  );

  server.registerTool(
    'hub_get_config',
    {
      description: 'Load persisted hub configuration (config.json) for this workspace root.',
      inputSchema: hubGetConfigInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubGetConfigInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      void parsed;
      const config = loadConfigFromDisk(mirrorRoot);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config }) }] };
    },
  );

  server.registerTool(
    'hub_update_config',
    {
      description: 'Optimistically update config.json with versioned concurrency control.',
      inputSchema: hubUpdateConfigInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubUpdateConfigInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const hit = store.getIdempotencyResult(parsed.data.idempotency_key);
        if (hit && typeof hit === 'object' && hit !== null && 'status' in hit) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(hit as Record<string, unknown>) }) }] };
        }
      }

      const out = updateConfigOnDisk(mirrorRoot, parsed.data);
      if (parsed.data.idempotency_key && out.status === 'success') {
        store.setIdempotencyResult(parsed.data.idempotency_key, out, IDEMP_TTL_MS);
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
    },
  );

  server.registerTool(
    'hub_checkpoint',
    {
      description: 'Persist a resumable checkpoint under .planning/hub/checkpoints for this agent/task.',
      inputSchema: hubCheckpointInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubCheckpointInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const hit = store.getIdempotencyResult(parsed.data.idempotency_key);
        if (hit && typeof hit === 'object' && hit !== null && 'checkpoint' in hit) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, checkpoint: (hit as { checkpoint: unknown }).checkpoint }) }] };
        }
      }

      const checkpoint = {
        agent_id: parsed.data.agent_id,
        task_id: parsed.data.task_id,
        progress_summary: parsed.data.progress_summary,
        context_snapshot: parsed.data.context_snapshot,
        timestamp: new Date(),
      };
      writeAgentCheckpoint(mirrorRoot, checkpoint);
      if (parsed.data.idempotency_key) {
        store.setIdempotencyResult(
          parsed.data.idempotency_key,
          {
            checkpoint: {
              ...checkpoint,
              timestamp: checkpoint.timestamp.toISOString(),
            },
          },
          IDEMP_TTL_MS,
        );
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              checkpoint: { ...checkpoint, timestamp: checkpoint.timestamp.toISOString() },
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_handoff',
    {
      description: 'Build a handoff package from the latest checkpoint plus task metadata.',
      inputSchema: hubHandoffInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubHandoffInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const cp = readAgentCheckpoint(mirrorRoot, parsed.data.agent_id, parsed.data.task_id);
      if (!cp) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'checkpoint_missing' }) }],
          isError: true,
        };
      }

      const task = taskService.getTask(parsed.data.task_id);
      const remaining = task ? [`continue task ${task.id} (${task.workflow_stage})`] : [`resume task ${parsed.data.task_id}`];

      const pkg = {
        task_id: parsed.data.task_id,
        checkpoint: {
          ...cp,
          timestamp: cp.timestamp.toISOString(),
        },
        remaining_steps: remaining,
        artifacts: [] as string[],
      };
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, package: pkg }) }] };
    },
  );

  server.registerTool(
    'hub_request_help',
    {
      description: 'Broadcast a help request to other agents (durable event + SSE).',
      inputSchema: hubRequestHelpInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubRequestHelpInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }

      const out = publisher.publish({
        sourceAgentId: parsed.data.agent_id,
        topic: `help.${parsed.data.topic}`,
        payload: {
          summary: parsed.data.summary,
          task_id: parsed.data.task_id,
          details: parsed.data.payload ?? null,
          correlation_id: parsed.data.correlation_id ?? null,
        },
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              broadcast: {
                ...out.event,
                timestamp: out.event.timestamp.toISOString(),
              },
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_report_progress',
    {
      description: 'Record lightweight autonomy loop progress for this agent/task.',
      inputSchema: hubReportProgressInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubReportProgressInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      const out = progressTracker.report(parsed.data);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
    },
  );

  server.registerTool(
    'hub_set_limits',
    {
      description: 'Configure per-agent safety caps for tool calls, tokens, and wall time.',
      inputSchema: hubSetLimitsInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubSetLimitsInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }],
          isError: true,
        };
      }
      const IDEMP_TTL_MS = 86_400_000;
      if (parsed.data.idempotency_key) {
        const hit = store.getIdempotencyResult(parsed.data.idempotency_key);
        if (hit && typeof hit === 'object' && hit !== null && 'status' in hit) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(hit as Record<string, unknown>) }) }] };
        }
      }
      const res = safetyLimiter.setPersisted(parsed.data.agent_id, parsed.data.limits, parsed.data.expected_version);
      const body =
        res.status === 'success'
          ? { status: 'success' as const, limits: res.limits, config_version: res.version }
          : { status: 'conflict' as const, limits: res.limits, config_version: res.version };
      if (parsed.data.idempotency_key && res.status === 'success') {
        store.setIdempotencyResult(parsed.data.idempotency_key, body, IDEMP_TTL_MS);
      }
      auditJournal.append({
        agentId: parsed.data.agent_id,
        taskId: null,
        action: 'hub.set_limits',
        details: body,
        correlationId: null,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...body }) }] };
    },
  );

  server.registerTool(
    'hub_token_ranking',
    {
      description:
        'Return all tracked agents ranked by token usage (least-used first). ' +
        'Useful for observing the token-aware task scheduler.',
      inputSchema: {},
    },
    async (_raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered', hint: 'call hub_register first' }) }],
          isError: true,
        };
      }
      const budgets = safetyLimiter.allBudgets();
      const ranking = budgets.map((b, idx) => ({
        rank: idx + 1,
        agent_id: b.agentId,
        tokens_used: b.usage.tokens,
        tokens_remaining: Number.isFinite(b.remainingTokens) ? b.remainingTokens : null,
        tool_calls: b.usage.calls,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ranking }) }] };
    },
  );

  server.registerTool(
    'hub_module_affinity',
    {
      description:
        'Query or declare module ownership. ' +
        'action="query": provide agent_id to see their modules, or module to see its owners. ' +
        'action="set": declare agent_id owns the specified module.',
      inputSchema: {
        action: z.enum(['query', 'set']).default('query').describe('Action: query or set ownership'),
        agent_id: z.string().min(1).optional().describe('Agent to query/set affinity for'),
        module: z.string().min(1).optional().describe('Module name (e.g. backend, frontend, data, infra, test)'),
      },
    },
    async ({ action, agent_id: queryAgentId, module: queryModule }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      }
      const row = store.getSessionByMcpId(sessionId);
      if (!row) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered', hint: 'call hub_register first' }) }],
          isError: true,
        };
      }
      if (!moduleAffinityService) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'affinity_service_unavailable' }) }], isError: true };
      }

      if (action === 'set') {
        if (!queryAgentId || !queryModule) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'set requires both agent_id and module' }) }], isError: true };
        }
        moduleAffinityService.declareOwnership(queryAgentId, [queryModule]);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, agent_id: queryAgentId, module: queryModule, action: 'declared' }) }] };
      }

      const result: Record<string, unknown> = { ok: true };
      if (queryAgentId) {
        result.agent_modules = moduleAffinityService.getAgentModules(queryAgentId);
      }
      if (queryModule) {
        result.module_owners = moduleAffinityService.getModuleOwners(queryModule);
      }
      if (!queryAgentId && !queryModule) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'provide agent_id or module' }) }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    'hub_set_display_name',
    {
      description: 'Update your agent display name (shown in UI) and optionally agent_type (solo/slave) and parent_agent_id.',
      inputSchema: {
        agent_id: z.string().min(1),
        display_name: z.string().min(1).optional(),
        agent_type: z.enum(['solo', 'slave']).optional(),
        parent_agent_id: z.string().nullable().optional(),
      },
    },
    async ({ agent_id: nameAgentId, display_name, agent_type, parent_agent_id }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (display_name !== undefined) updates.displayName = display_name;
      if (agent_type !== undefined) updates.agentType = agent_type;
      if (parent_agent_id !== undefined) updates.parentAgentId = parent_agent_id;

      hubDb.update(sessions).set(updates).where(eq(sessions.agentId, nameAgentId)).run();

      if (parent_agent_id !== undefined) {
        if (parent_agent_id) {
          publisher.publish({
            sourceAgentId: 'hub-system',
            topic: `${nameAgentId}.inbox`,
            payload: { type: 'assigned', parent_agent_id, assigned_at: new Date().toISOString() },
          });
        } else {
          publisher.publish({
            sourceAgentId: 'hub-system',
            topic: `${nameAgentId}.inbox`,
            payload: { type: 'detached', detached_at: new Date().toISOString() },
          });
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, agent_id: nameAgentId, display_name }) }] };
    },
  );

  server.registerTool(
    'hub_report_degradation',
    {
      description: 'Report quality degradation of an agent. Logs to audit journal and notifies CLK via event.',
      inputSchema: {
        reporter_agent_id: z.string().min(1).describe('Agent reporting the degradation'),
        suspect_agent_id: z.string().min(1).describe('Agent suspected of degradation'),
        evidence: z.string().min(1).describe('Evidence of degradation'),
        severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      },
    },
    async ({ reporter_agent_id, suspect_agent_id, evidence, severity }, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };

      auditJournal.append({
        agentId: reporter_agent_id,
        taskId: null,
        action: 'quality.degradation',
        details: JSON.stringify({ suspect_agent_id, evidence, severity }),
        correlationId: null,
      });

      publisher.publish({
        sourceAgentId: reporter_agent_id,
        topic: 'clk.inbox',
        payload: { type: 'quality_degradation', suspect_agent_id, evidence, severity, reporter: reporter_agent_id },
      });

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, reported: true, notified_clk: true }) }] };
    },
  );

  server.registerTool(
    'hub_system_resources',
    {
      description: 'Get current system resource usage (CPU, memory, capacity).',
      inputSchema: {},
    },
    async (_raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };

      const os = await import('node:os');
      const cpus = os.cpus();
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const memUsagePct = Math.round(((totalMem - freeMem) / totalMem) * 100);
      const cpuUsagePct = Math.round(
        cpus.reduce((sum, c) => {
          const total = Object.values(c.times).reduce((a, b) => a + b, 0);
          return sum + ((total - c.times.idle) / total) * 100;
        }, 0) / cpus.length,
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ok: true,
            resources: {
              cpu: { cores: cpus.length, usage_pct: cpuUsagePct },
              memory: { total_mb: Math.round(totalMem / 1048576), free_mb: Math.round(freeMem / 1048576), usage_pct: memUsagePct },
              capacity: { at_90_pct_limit: memUsagePct > 90 || cpuUsagePct > 90 },
            },
          }),
        }],
      };
    },
  );

  server.registerTool(
    'hub_get_audit_log',
    {
      description: 'Read append-only audit entries (operator diagnostics).',
      inputSchema: hubGetAuditLogInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubGetAuditLogInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      const lim = Math.min(parsed.data.limit ?? 100, 1000);
      const { entries, cursor } = auditJournal.list({
        afterId: parsed.data.after_id,
        limit: lim,
        agentId: parsed.data.agent_id,
        taskId: parsed.data.task_id,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              entries: entries.map((e) => ({
                ...e,
                timestamp: e.timestamp.toISOString(),
              })),
              cursor,
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'hub_get_health',
    {
      description: 'Hub liveness snapshot (stale sessions, backlog, claimed tasks).',
      inputSchema: hubGetHealthInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubGetHealthInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      void parsed;
      const health = buildHealthStatus(hubDb);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, health }) }] };
    },
  );

  server.registerTool(
    'hub_get_progress',
    {
      description: 'Roll up task completion counts by workflow stage.',
      inputSchema: hubGetProgressInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }
      if (!store.getSessionByMcpId(sessionId)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
          isError: true,
        };
      }
      const parsed = hubGetProgressInputSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }],
          isError: true,
        };
      }
      const by_phase = buildProgressByPhase(hubDb, parsed.data.workflow_stage);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, by_phase }) }] };
    },
  );

  // ─── v0.2 Question-based workflow tools ─────────────────────────

  server.registerTool(
    'hub_submit_question',
    {
      description: 'Submit a QuestionPacket wrapped in a PacketEnvelope. The question enters the queue and becomes claimable by the target role.',
      inputSchema: hubSubmitQuestionInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      if (!questionService) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_service_unavailable' }) }], isError: true };

      const parsed = hubSubmitQuestionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input', details: parsed.error.message }) }], isError: true };
      }

      try {
        const out = questionService.submitQuestion(parsed.data.envelope);
        auditJournal.append({
          agentId: row.agentId,
          taskId: null,
          action: 'hub.submit_question',
          details: { question_id: out.question_id },
          correlationId: parsed.data.envelope.correlation_id ?? null,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'submit_question_failed' }) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_claim_question',
    {
      description: 'Claim the next ready question for your role. Returns a full PacketEnvelope<QuestionPacket> or null if none available.',
      inputSchema: hubClaimQuestionInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      if (!questionService) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_service_unavailable' }) }], isError: true };

      const parsed = hubClaimQuestionInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }], isError: true };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }], isError: true };
      }

      try {
        const out = questionService.claimQuestion(parsed.data.role, parsed.data.agent_id, parsed.data.lease_duration_ms);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'claim_question_failed' }) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_submit_answer',
    {
      description: 'Submit an AnswerPacket wrapped in a PacketEnvelope. Closes the question as answered.',
      inputSchema: hubSubmitAnswerInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      if (!questionService) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_service_unavailable' }) }], isError: true };

      const parsed = hubSubmitAnswerInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input', details: parsed.error.message }) }], isError: true };
      }

      try {
        const out = questionService.submitAnswer(parsed.data.envelope);
        auditJournal.append({
          agentId: row.agentId,
          taskId: null,
          action: 'hub.submit_answer',
          details: { question_id: out.question_id },
          correlationId: parsed.data.envelope.correlation_id ?? null,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'submit_answer_failed' }) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_submit_escalation',
    {
      description: 'Submit an EscalationPacket wrapped in a PacketEnvelope. Marks the question as escalated and routes to the escalate_to role.',
      inputSchema: hubSubmitEscalationInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      if (!questionService) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_service_unavailable' }) }], isError: true };

      const parsed = hubSubmitEscalationInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input', details: parsed.error.message }) }], isError: true };
      }

      try {
        const out = questionService.submitEscalation(parsed.data.envelope);
        auditJournal.append({
          agentId: row.agentId,
          taskId: null,
          action: 'hub.submit_escalation',
          details: { question_id: out.question_id, escalated_to: out.escalated_to },
          correlationId: parsed.data.envelope.correlation_id ?? null,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'submit_escalation_failed' }) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_resolve_escalation',
    {
      description: 'Resolve an escalated question by revising it (new QuestionPacket) or cancelling it.',
      inputSchema: hubResolveEscalationInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };
      if (!questionService) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'question_service_unavailable' }) }], isError: true };

      const parsed = hubResolveEscalationInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }], isError: true };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }], isError: true };
      }

      try {
        const out = questionService.resolveEscalation(parsed.data);
        auditJournal.append({
          agentId: row.agentId,
          taskId: null,
          action: 'hub.resolve_escalation',
          details: out,
          correlationId: null,
        });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ...out }) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'resolve_escalation_failed' }) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'hub_get_context_ref',
    {
      description: 'Fetch the content of a context_ref (e.g. file:src/foo.ts, phase-brief:P-1). Used by agents to pull extended context on demand.',
      inputSchema: hubGetContextRefInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };

      const parsed = hubGetContextRefInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input' }) }], isError: true };
      }
      if (parsed.data.agent_id !== row.agentId) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'agent_id_mismatch' }) }], isError: true };
      }

      const ref = parsed.data.context_ref;

      if (ref.startsWith('file:')) {
        const filePath = ref.slice(5).split('#')[0] ?? ref.slice(5);
        const doc = store.getPlanningDocument(filePath);
        if (doc) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref, content: doc.content, found: true }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref, found: false }) }] };
      }

      if (ref.startsWith('phase-brief:')) {
        const briefPath = `.planning/${ref.slice(12).split('@')[0]}/BRIEF.md`;
        const doc = store.getPlanningDocument(briefPath);
        if (doc) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref, content: doc.content, found: true }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref, found: false }) }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ref, found: false }) }] };
    },
  );

  server.registerTool(
    'hub_sotadiff_record',
    {
      description: 'Record a SoTADiff entry (code change with intent, files, and optional git commit hash).',
      inputSchema: hubSotaDiffRecordInputSchema.shape,
    },
    async (raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }], isError: true };
      const row = store.getSessionByMcpId(sessionId);
      if (!row) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }], isError: true };

      const parsed = hubSotaDiffRecordInputSchema.safeParse(raw);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid_input', details: parsed.error.message }) }], isError: true };
      }

      const { agent_id, git_commit, intent, files, summary } = parsed.data;
      const result = store.recordSoTADiff({
        agentId: agent_id,
        gitCommit: git_commit,
        intent,
        files,
        summary,
      });

      const p22Results: Array<{ file: string; type: string; other_agent: string }> = [];
      const twentyFourHoursAgo = new Date(Date.now() - 86_400_000);
      const timeBasedEntries = hubDb.select().from(sotadiffEntries)
        .where(and(
          ne(sotadiffEntries.agentId, agent_id),
          gt(sotadiffEntries.createdAt, twentyFourHoursAgo),
        ))
        .all();
      const countBasedEntries = hubDb.select().from(sotadiffEntries)
        .where(ne(sotadiffEntries.agentId, agent_id))
        .orderBy(sql`created_at DESC`)
        .limit(10)
        .all();
      const seenIds = new Set<string>();
      const otherRecent = [...timeBasedEntries, ...countBasedEntries].filter(e => {
        if (seenIds.has(e.id)) return false;
        seenIds.add(e.id);
        return true;
      });

      const currentFilePaths = new Set(
        (files as Array<{ path: string }>).map(f => f.path),
      );

      for (const otherEntry of otherRecent) {
        const otherFiles = JSON.parse(otherEntry.filesJson) as Array<{ path: string; op: string; lines_changed: number }>;
        for (const of of otherFiles) {
          if (currentFilePaths.has(of.path)) {
            const alertId = randomUUID();
            hubDb.insert(p22Alerts).values({
              id: alertId,
              agentId: agent_id,
              gitCommit: git_commit ?? null,
              alertType: 'file_overlap',
              filePath: of.path,
              otherAgentId: otherEntry.agentId,
              details: `File "${of.path}" was also modified by ${otherEntry.agentId} in commit ${otherEntry.gitCommit ?? 'unknown'} (${otherEntry.intent})`,
              acknowledged: false,
              createdAt: new Date(),
            }).run();
            p22Results.push({ file: of.path, type: 'file_overlap', other_agent: otherEntry.agentId });
          }
        }
      }

      const response: Record<string, unknown> = { ok: true, id: result.id };
      if (p22Results.length > 0) {
        response.p22_alerts = p22Results;
        response.p22_warning = `P22: ${p22Results.length} file(s) overlap with other agents' recent commits. Check compliance_warnings in next heartbeat.`;
      }

      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    },
  );

  return server;
}

function serializeAcquireLease(out: HubAcquireLeaseOutput): Record<string, unknown> {
  if (out.status === 'granted') {
    return {
      status: 'granted',
      lease: {
        ...out.lease,
        expires_at: out.lease.expires_at.toISOString(),
        created_at: out.lease.created_at.toISOString(),
      },
    };
  }
  return {
    status: 'conflict',
    holder: {
      ...out.holder,
      expires_at: out.holder.expires_at.toISOString(),
      created_at: out.holder.created_at.toISOString(),
    },
  };
}

function reviveAcquireLease(value: unknown): HubAcquireLeaseOutput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.status === 'granted' && v.lease && typeof v.lease === 'object') {
    const l = v.lease as Record<string, unknown>;
    if (typeof l.expires_at !== 'string' || typeof l.created_at !== 'string') return null;
    return {
      status: 'granted',
      lease: {
        path: l.path as string,
        agent_id: l.agent_id as string,
        lease_id: l.lease_id as string,
        expires_at: new Date(l.expires_at),
        created_at: new Date(l.created_at),
      },
    };
  }
  if (v.status === 'conflict' && v.holder && typeof v.holder === 'object') {
    const h = v.holder as Record<string, unknown>;
    if (typeof h.expires_at !== 'string' || typeof h.created_at !== 'string') return null;
    return {
      status: 'conflict',
      holder: {
        path: h.path as string,
        agent_id: h.agent_id as string,
        lease_id: h.lease_id as string,
        expires_at: new Date(h.expires_at),
        created_at: new Date(h.created_at),
      },
    };
  }
  return null;
}

/** Wire Streamable HTTP MCP routes onto an Express app. */
export function mountStreamableHttpHub(
  app: Express,
  deps: {
    store: HubStore;
    registry: SessionRegistry;
    ctx: HubContext;
    sseHub: SseHub;
    publisher: BroadcastPublisher;
    eventSubscriber: EventSubscriber;
    mirrorRoot: string;
    taskService: TaskService;
    pathLeaseService: PathLeaseService;
    progressTracker: ProgressTracker;
    safetyLimiter: SafetyLimiter;
    auditJournal: AuditJournal;
    hubDb: HubDb;
    moduleAffinityService?: ModuleAffinityService;
    lifecycleTracker?: import('../lifecycle/tracker.js').LifecycleTracker;
    questionService?: QuestionService;
  },
): StreamableHttpHub {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const { ctx, registry, sseHub } = deps;

  // ── UI Interaction REST API ───────────────────────────────────────
  mountUiRoutes(app, deps.hubDb, deps.ctx, deps.publisher, deps.store, deps.taskService);

  app.get('/hub/events/stream', (req, res) => {
    const sid = typeof req.query.mcp_session_id === 'string' ? req.query.mcp_session_id : '';
    if (!sid) {
      res.status(400).send('missing mcp_session_id');
      return;
    }
    const sessionRow = registry.getByMcpSession(sid);
    if (!sessionRow) {
      res.status(401).send('unknown session');
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(': connected\n\n');
    const detach = sseHub.addClient(sessionRow.agentId, res);
    req.on('close', () => {
      detach();
    });
  });

  // 在 MCP 请求到达之前，拦截 tools/call 请求并记录到 lifecycleTracker
  if (deps.lifecycleTracker) {
    const tracker = deps.lifecycleTracker;
    app.post('/mcp', ((req, _res, next) => {
      const body = req.body;
      if (body && body.method === 'tools/call' && body.params?.name) {
        const sid = (Array.isArray(req.headers['mcp-session-id'])
          ? req.headers['mcp-session-id'][0]
          : req.headers['mcp-session-id']) ?? '';
        const sessionRow = sid ? registry.getByMcpSession(sid) : undefined;
        if (sessionRow) {
          tracker.recordCall(sessionRow.agentId, body.params.name as string);
        }
      }
      next();
    }) as RequestHandler);
  }

  const mcpPostHandler: RequestHandler = async (req, res) => {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && req.body && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };
        const mcp = createMcpServerForHub(deps);
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32_000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'mcp POST error');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  };

  const mcpGetHandler: RequestHandler = async (req, res) => {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  const mcpDeleteHandler: RequestHandler = async (req, res) => {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  };

  app.post('/mcp', mcpPostHandler);
  app.get('/mcp', mcpGetHandler);
  app.delete('/mcp', mcpDeleteHandler);

  return { app, transports };
}

/** Express app with DNS rebinding protection and large payload support. */
export function createHubExpress(): Express {
  const app = express();
  app.set('etag', false);
  app.use(express.json({ limit: '10mb' }));
  app.use(localhostHostValidation());
  return app;
}

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

function mountUiRoutes(app: Express, db: HubDb, ctx: HubContext, publisher?: BroadcastPublisher, store?: HubStore, taskService?: TaskService): void {
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
      if (!agent_id || !display_name) {
        res.status(400).json({ error: 'agent_id and display_name are required' });
        return;
      }

      // Register only — no initial prompt (default for solo-web startup)
      if (!prompt) {
        const result = store!.registerAgentOnly({
          agentId: agent_id,
          displayName: display_name,
        });
        if (!result.ok) {
          if (result.reason.startsWith('agent_id_in_use')) {
            res.status(409).json({ error: 'agent_id_in_use', message: 'This agent_id is already active on the Hub. Use a different agent_id or wait for the existing one to expire.', agent_id });
            return;
          }
          res.status(400).json({ error: result.reason });
          return;
        }
        res.json({ ok: true, agent_id, prompt_id: null });
        return;
      }

      if (!Array.isArray(options) || options.length === 0) {
        res.status(400).json({ error: 'options (non-empty string array) is required when prompt is provided' });
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

  // ── File uploads: drag-to-reference in PromptCard ──
  const uploadsDir = join(process.cwd(), '.planning/hub/uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadsDir),
      filename: (_req, file, cb) => {
        const ext = extname(file.originalname);
        const base = file.originalname.replace(ext, '').replace(/[^a-zA-Z0-9_\-.]/g, '_');
        cb(null, `${Date.now()}-${base}${ext}`);
      },
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  // CORS preflight for file uploads (Chrome Private Network Access sends OPTIONS first)
  app.options('/api/ui/uploads', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', _req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.status(204).end();
  });

  app.post('/api/ui/uploads', upload.array('files', 10), (req, res) => {
    try {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      const files = req.files as Express.Multer.File[] | undefined;
      if (!files || files.length === 0) {
        res.status(400).json({ error: 'no files provided' });
        return;
      }
      const results = files.map(f => ({
        original_name: f.originalname,
        path: f.path,
        size: f.size,
      }));
      res.json({ ok: true, files: results });
    } catch (err) {
      ctx.logger.error({ err }, 'file upload error');
      res.status(500).json({ error: 'upload failed' });
    }
  });

  app.get('/api/ui/health', async (_req, res) => {
    const checks = await checkAllServices(ctx);
    res.json(checks);
  });

  // ── Project Aggregation API ─────────────────────────────────────
  app.get('/api/ui/project', async (_req, res) => {
    const result: Record<string, unknown> = { ts: Date.now() };
    const grab = async (_label: string, url: string, timeoutMs = 3000) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (r.ok) return await r.json();
        return { _error: `HTTP ${r.status}` };
      } catch (err) {
        return { _error: String(err) };
      }
    };

    const [ppHealth, ppSummary, ppRecentProjects, sotStatus] = await Promise.all([
      grab('pp-health', `http://127.0.0.1:${PP_API_PORT}/health`),
      grab('pp-summary', `http://127.0.0.1:${PP_API_PORT}/api/dashboard/summary`),
      grab('pp-projects', `http://127.0.0.1:${PP_API_PORT}/api/dashboard/recent-projects`),
      grab('sot-status', `http://127.0.0.1:${SOTAGENT_API_PORT}/api/status`),
    ]);

    result.polarPrivate = {
      health: ppHealth,
      summary: ppSummary,
      recentProjects: ppRecentProjects,
    };
    result.sotAgent = sotStatus;

    // Hub 自身的统计
    const agentRows = db.select().from(agentRoles).all();
    const taskRows = db.select().from(tasks).all();
    result.hub = {
      agents: agentRows.length,
      agentList: agentRows.map((a) => ({
        id: a.agentId,
        role: a.role,
        assignedAt: a.assignedAt,
      })),
      tasks: {
        total: taskRows.length,
        open: taskRows.filter((t) => t.status === 'open').length,
        claimed: taskRows.filter((t) => t.status === 'claimed').length,
        done: taskRows.filter((t) => t.status === 'done').length,
        blocked: taskRows.filter((t) => t.status === 'blocked').length,
      },
    };

    res.json(result);
  });

  // ── Agents Summary for SOLO to query available Slaves ──────────────
  app.get('/api/ui/agents/summary', (_req, res) => {
    try {
      const allSessions = db.select().from(sessions).all();
      const now = Date.now();
      const aliveAgentIds = new Set(
        allSessions
          .filter((s) => s.lastPingAt && now - new Date(s.lastPingAt).getTime() < ALIVE_THRESHOLD_MS_CONST)
          .map((s) => s.agentId),
      );

      // Auto-detach slaves whose parent SOLO is dead
      for (const s of allSessions) {
        if (s.parentAgentId && !aliveAgentIds.has(s.parentAgentId)) {
          db.update(sessions)
            .set({ parentAgentId: null, updatedAt: new Date(now) })
            .where(eq(sessions.agentId, s.agentId))
            .run();
          s.parentAgentId = null;
        }
      }

      const alive = allSessions.filter((s) => aliveAgentIds.has(s.agentId));
      const solos = alive.filter((s) => s.agentType !== 'slave');
      const slaves = alive.filter((s) => s.agentType === 'slave');
      const freeSlaves = slaves.filter((s) => !s.parentAgentId);
      const assignedSlaves = slaves.filter((s) => !!s.parentAgentId);

      const byParent: Record<string, Array<{ id: string; name: string | null }>> = {};
      for (const s of assignedSlaves) {
        const pid = s.parentAgentId!;
        if (!byParent[pid]) byParent[pid] = [];
        byParent[pid].push({ id: s.agentId, name: s.displayName });
      }

      res.json({
        total_alive: alive.length,
        solos: solos.map((s) => ({
          id: s.agentId,
          name: s.displayName,
          slaves: byParent[s.agentId] ?? [],
        })),
        free_slaves: freeSlaves.map((s) => ({
          id: s.agentId,
          name: s.displayName,
        })),
        assigned_slaves: assignedSlaves.length,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'ui agents summary error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Events API for Slave task visibility ────────────────────────────
  app.get('/api/ui/events', (req, res) => {
    try {
      const agentId = typeof req.query.agent_id === 'string' ? req.query.agent_id : undefined;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      let rows;
      if (agentId) {
        rows = db
          .select()
          .from(events)
          .where(
            sql`${events.topic} LIKE '%' || ${agentId} || '%' OR ${events.sourceAgentId} = ${agentId}`,
          )
          .orderBy(sql`${events.sequenceNumber} DESC`)
          .limit(limit)
          .all();
      } else {
        rows = db
          .select()
          .from(events)
          .orderBy(sql`${events.sequenceNumber} DESC`)
          .limit(limit)
          .all();
      }
      const mapped = rows.map((r) => {
        let payload: unknown;
        try { payload = JSON.parse(r.payload); } catch { payload = r.payload; }
        return {
          id: r.id,
          source_agent_id: r.sourceAgentId,
          topic: r.topic,
          payload,
          created_at: r.createdAt,
        };
      });
      res.json(mapped);
    } catch (err) {
      ctx.logger.error({ err }, 'ui events list error');
      res.status(500).json({ error: 'internal' });
    }
  });


  // ── Agent Registry API (多 Agent 统一注册) ───────────────────────────────

  const MAIN_MODELS = [
    { id: 'glm-5.1', name: 'GLM 5.1', description: '智谱 GLM 5.1 - 强大的通用模型' },
    { id: 'qwen-3.6-plus', name: 'Qwen 3.6 Plus', description: '阿里 Qwen 3.6 Plus - 编程能力强' },
  ];

  const SUBAGENT_MODELS = [
    { id: 'glm-5.1', name: 'GLM 5.1' },
    { id: 'qwen-3.6-plus', name: 'Qwen 3.6 Plus' },
    { id: 'minimax-2.7-highspeed', name: 'MiniMax 2.7 Highspeed' },
  ];

  const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 秒无心跳标记 inactive
  const INACTIVE_CLEANUP_MS = 5 * 60_000; // 5 分钟 inactive 自动清理

  // GET /api/agents/start-config - 返回可选模型列表
  app.get('/api/agents/start-config', (_req, res) => {
    res.json({
      main_models: MAIN_MODELS,
      subagent_models: SUBAGENT_MODELS,
    });
  });

  // POST /api/agents/register - Agent 注册
  app.post('/api/agents/register', (req, res) => {
    try {
      const { agent_type, agent_name, main_model, subagent_model, capabilities } = req.body as {
        agent_type?: string;
        agent_name?: string;
        main_model?: string;
        subagent_model?: string;
        capabilities?: string[];
      };

      if (!agent_type || !['polarclaw', 'polarpilot', 'polarcopilot'].includes(agent_type)) {
        res.status(400).json({ error: 'agent_type must be polarclaw, polarpilot, or polarcopilot' });
        return;
      }

      // 验证模型选择
      if (main_model && !MAIN_MODELS.find(m => m.id === main_model)) {
        res.status(400).json({ error: `invalid main_model: ${main_model}` });
        return;
      }
      if (subagent_model && !SUBAGENT_MODELS.find(m => m.id === subagent_model)) {
        res.status(400).json({ error: `invalid subagent_model: ${subagent_model}` });
        return;
      }

      const now = Date.now();
      const agentId = `${agent_type}-${now}`;
      const mcpSessionId = `registry-${agentId}`;

      // 插入 session
      db.insert(sessions)
        .values({
          mcpSessionId,
          agentId,
          label: agent_name || agent_type,
          displayName: agent_name || agent_type,
          agentType: agent_type,
          mainModel: main_model || 'qwen-3.6-plus',
          subagentModel: subagent_model || 'qwen-3.6-plus',
          agentStatus: 'active',
          lastHeartbeat: new Date(now),
          createdAt: new Date(now),
          updatedAt: new Date(now),
        })
        .run();

      // 如果有 capabilities，写入 agentCapabilities
      if (capabilities && capabilities.length > 0) {
        db.insert(agentCapabilities)
          .values({
            agentId,
            rolesJson: JSON.stringify([agent_type]),
            skillsJson: JSON.stringify(capabilities),
            updatedAt: new Date(now),
          })
          .run();
      }

      ctx.logger.info({ agent_id: agentId, agent_type, main_model, subagent_model }, 'agent registered');

      res.json({
        ok: true,
        agent_id: agentId,
        hub_port: process.env.PC_HUB_PORT || 8040,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'agent register error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/agents/:id/heartbeat - 心跳
  app.post('/api/agents/:id/heartbeat', (req, res) => {
    try {
      const agentId = req.params.id;
      const row = db.select().from(sessions).where(eq(sessions.agentId, agentId)).get();

      if (!row) {
        res.status(404).json({ error: 'agent not found' });
        return;
      }

      const now = Date.now();
      db.update(sessions)
        .set({
          lastHeartbeat: new Date(now),
          agentStatus: 'active',
          updatedAt: new Date(now),
        })
        .where(eq(sessions.agentId, agentId))
        .run();

      res.json({ ok: true, ttl: HEARTBEAT_TIMEOUT_MS / 1000 });
    } catch (err) {
      ctx.logger.error({ err }, 'heartbeat error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/agents - 列出所有活跃 Agent
  app.get('/api/agents', (_req, res) => {
    try {
      const now = Date.now();
      const rows = db.select().from(sessions).all();

      const agents = rows
        .filter(r => r.mainModel || r.subagentModel) // 只返回注册过的 Agent
        .map(r => {
          const lastHb = r.lastHeartbeat ? new Date(r.lastHeartbeat).getTime() : 0;
          const status = now - lastHb > HEARTBEAT_TIMEOUT_MS ? 'inactive' : (r.agentStatus || 'active');
          return {
            agent_id: r.agentId,
            agent_type: r.agentType,
            display_name: r.displayName,
            main_model: r.mainModel,
            subagent_model: r.subagentModel,
            status,
            last_heartbeat: lastHb,
            current_prompt_id: r.currentPromptId,
            blocked_since: r.blockedSince ? new Date(r.blockedSince).getTime() : null,
          };
        });

      res.json(agents);
    } catch (err) {
      ctx.logger.error({ err }, 'agents list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/agents/:id/status - 单个 Agent 状态
  app.get('/api/agents/:id/status', (req, res) => {
    try {
      const agentId = req.params.id;
      const row = db.select().from(sessions).where(eq(sessions.agentId, agentId)).get();

      if (!row) {
        res.status(404).json({ error: 'agent not found' });
        return;
      }

      const now = Date.now();
      const lastHb = row.lastHeartbeat ? new Date(row.lastHeartbeat).getTime() : 0;
      const status = now - lastHb > HEARTBEAT_TIMEOUT_MS ? 'inactive' : (row.agentStatus || 'active');
      const blockedForMs = row.blockedSince ? now - new Date(row.blockedSince).getTime() : null;

      res.json({
        agent_id: agentId,
        status,
        current_prompt_id: row.currentPromptId,
        blocked_for_ms: blockedForMs,
        main_model: row.mainModel,
        subagent_model: row.subagentModel,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'agent status error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // POST /api/agents/:id/unregister - 主动注销
  app.post('/api/agents/:id/unregister', (req, res) => {
    try {
      const agentId = req.params.id;
      db.update(sessions)
        .set({
          agentStatus: 'inactive',
          displayName: null,
          mainModel: null,
          subagentModel: null,
          updatedAt: new Date(),
        })
        .where(eq(sessions.agentId, agentId))
        .run();

      ctx.logger.info({ agent_id: agentId }, 'agent unregistered');
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'unregister error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Agent Process Management (Web One-Click Start) ──────────────────────────
  // 内存中的 Agent 进程表
  const agentProcesses = new Map<string, {
    pid: number;
    agentType: string;
    startedAt: number;
    status: 'starting' | 'active' | 'dead';
    aliveConnection?: import('express').Response;
    lastHeartbeat: number;
  }>();

  // POST /api/agents/start - 一键启动 Agent 进程
  app.post('/api/agents/start', async (req, res) => {
    try {
      const { agent_type, main_model, subagent_model } = req.body as {
        agent_type?: string;
        main_model?: string;
        subagent_model?: string;
      };

      if (!agent_type || !['polarclaw', 'polarpilot'].includes(agent_type)) {
        res.status(400).json({ error: 'agent_type must be polarclaw or polarpilot' });
        return;
      }

      // 验证模型
      const mainModel = main_model || 'qwen-3.6-plus';
      const subagentModel = subagent_model || 'qwen-3.6-plus';
      if (!MAIN_MODELS.find(m => m.id === mainModel)) {
        res.status(400).json({ error: `invalid main_model: ${mainModel}` });
        return;
      }
      if (!SUBAGENT_MODELS.find(m => m.id === subagentModel)) {
        res.status(400).json({ error: `invalid subagent_model: ${subagentModel}` });
        return;
      }

      const now = Date.now();
      const agentId = `${agent_type}-${now}`;
      const hubPort = process.env.PC_HUB_PORT || 8040;

      // 确定项目路径
      const projectPath = agent_type === 'polarclaw'
        ? (process.env.POLARCLAW_PATH || `${process.env.HOME}/Polarisor/PolarClaw`)
        : (process.env.POLARPILOT_PATH || `${process.env.HOME}/Polarisor/PolarPilot`);

      // spawn 子进程
      const { spawn } = await import('node:child_process');
      const child = spawn('node', ['dist/main.js'], {
        cwd: projectPath,
        env: {
          ...process.env,
          HUB_WEB_URL: `http://127.0.0.1:${hubPort}`,
          AGENT_ID: agentId,
          MAIN_MODEL: mainModel,
          SUBAGENT_MODEL: subagentModel,
          MODE: 'hub-web',
          HUB_WEB_ENABLED: '1',
          HUB_MAIN_MODEL: mainModel,
          HUB_SUBAGENT_MODEL: subagentModel,
        },
        detached: true,
        stdio: 'ignore',
      });

      // 记录进程
      agentProcesses.set(agentId, {
        pid: child.pid!,
        agentType: agent_type,
        startedAt: now,
        status: 'starting',
        lastHeartbeat: now,
      });

      child.unref();
      ctx.logger.info({ agent_id: agentId, pid: child.pid, agent_type }, 'agent process started');

      res.json({
        ok: true,
        agent_id: agentId,
        hub_port: Number(hubPort),
        status: 'starting',
      });
    } catch (err) {
      ctx.logger.error({ err }, 'agent start error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // GET /api/agents/:id/alive - SSE 长连接心跳
  app.get('/api/agents/:id/alive', (req, res) => {
    const agentId = req.params.id;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // 标记为 active
    const proc = agentProcesses.get(agentId);
    if (proc) {
      proc.status = 'active';
      proc.aliveConnection = res;
      proc.lastHeartbeat = Date.now();
    }

    // 更新数据库状态
    const row = db.select().from(sessions).where(eq(sessions.agentId, agentId)).get();
    if (row) {
      db.update(sessions)
        .set({ agentStatus: 'active', lastHeartbeat: new Date(), updatedAt: new Date() })
        .where(eq(sessions.agentId, agentId))
        .run();
    }

    // 每 30 秒发心跳
    const heartbeatInterval = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${Date.now()}\n\n`);
    }, 30000);

    // 连接关闭时清理
    res.on('close', () => {
      clearInterval(heartbeatInterval);
      const proc = agentProcesses.get(agentId);
      if (proc) {
        proc.status = 'dead';
        proc.aliveConnection = undefined;
      }
      ctx.logger.info({ agent_id: agentId }, 'agent alive connection closed');
      cleanupAgentProcess(agentId);
    });

    // 立即发送一个事件确认连接
    res.write(`event: connected\ndata: ${agentId}\n\n`);
  });

  // POST /api/agents/:id/kill - 手动终止 Agent
  app.post('/api/agents/:id/kill', async (req, res) => {
    try {
      const agentId = req.params.id;
      await cleanupAgentProcess(agentId);
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'kill error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // 清理函数
  async function cleanupAgentProcess(agentId: string) {
    const proc = agentProcesses.get(agentId);
    if (!proc) return;

    // 1. 杀进程
    if (proc.pid) {
      try {
        process.kill(proc.pid, 'SIGTERM');
        ctx.logger.info({ agent_id: agentId, pid: proc.pid }, 'process killed');
      } catch {
        // 进程已退出
      }
    }

    // 2. 删除临时文件
    const tempDir = `/tmp/agent-${agentId}`;
    try {
      const { rm } = await import('node:fs/promises');
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // 目录不存在
    }

    // 3. 从内存移除
    agentProcesses.delete(agentId);

    // 4. 数据库标记
    db.update(sessions)
      .set({ agentStatus: 'inactive', updatedAt: new Date() })
      .where(eq(sessions.agentId, agentId))
      .run();

    ctx.logger.info({ agent_id: agentId }, 'agent cleaned up');
  }

  // 僵尸进程检测（每 60 秒）
  setInterval(() => {
    const now = Date.now();
    for (const [agentId, proc] of agentProcesses) {
      // 检查进程是否存活
      try {
        process.kill(proc.pid, 0);
      } catch {
        // 进程已死
        ctx.logger.info({ agent_id: agentId, pid: proc.pid }, 'zombie process detected');
        cleanupAgentProcess(agentId);
        continue;
      }

      // 检查心跳超时（90 秒）
      if (now - proc.lastHeartbeat > 90000) {
        ctx.logger.info({ agent_id: agentId }, 'heartbeat timeout');
        cleanupAgentProcess(agentId);
      }
    }
  }, 60000);

  // 定期清理 inactive Agent（每分钟）
  setInterval(() => {
    try {
      const now = Date.now();
      const rows = db.select().from(sessions).all();
      for (const r of rows) {
        if (!r.lastHeartbeat) continue;
        const lastHb = new Date(r.lastHeartbeat).getTime();
        if (now - lastHb > INACTIVE_CLEANUP_MS && r.agentStatus === 'inactive') {
          db.delete(sessions).where(eq(sessions.agentId, r.agentId)).run();
          ctx.logger.info({ agent_id: r.agentId }, 'inactive agent cleaned up');
        }
      }
    } catch (err) {
      ctx.logger.error({ err }, 'cleanup error');
    }
  }, 60_000);

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'polarcop-hub', uptime: process.uptime() });
  });

  // ── Three-layer verification (Protocol C step 3) ─────────────────
  app.post('/api/verify', (req, res) => {
    try {
      const { intent, files, summary } = req.body as {
        agent_id?: string; git_commit?: string;
        intent?: string; files?: Array<{ path: string; op: string; lines_changed: number }>;
        summary?: string;
      };
      const issues: string[] = [];
      if (files && Array.isArray(files)) {
        for (const f of files) {
          if (f.lines_changed > 300) issues.push(`${f.path}: ${f.lines_changed} lines changed (>300, check G1)`);
          if (f.path.includes('.env') && f.op === 'create') issues.push(`${f.path}: .env file committed (check G6)`);
        }
        const totalLines = files.reduce((s, f) => s + f.lines_changed, 0);
        if (totalLines > 1000) issues.push(`Total ${totalLines} lines changed — large commit, consider splitting`);
      }
      if (intent && summary && intent !== summary) {
        const intentWords = new Set(intent.toLowerCase().split(/\s+/));
        const summaryWords = new Set(summary.toLowerCase().split(/\s+/));
        const overlap = [...intentWords].filter(w => summaryWords.has(w)).length;
        if (overlap < Math.min(intentWords.size, summaryWords.size) * 0.3) {
          issues.push('Intent and summary have low overlap — verify commit matches original intent');
        }
      }
      const verdict = issues.length === 0 ? 'pass' : 'warn';
      res.json({ verdict, issues, checked_at: new Date().toISOString() });
    } catch (err) {
      ctx.logger.error({ err }, 'verify error');
      res.status(500).json({ error: 'internal' });
    }
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
    ssot_refs: Array<{ ref: string; task_linked: boolean }>;
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

    // 2. Check SSoT references
    const ssotRefPattern = /\[SSoT:([^\]]+)\]/g;
    const ssotRefs: Array<{ ref: string; task_linked: boolean }> = [];
    let match;
    while ((match = ssotRefPattern.exec(planMarkdown)) !== null) {
      ssotRefs.push({ ref: match[1]!, task_linked: true });
    }
    if (ssotRefs.length === 0) {
      const legacyRefPattern = /\b(R\d+)\b/g;
      while ((match = legacyRefPattern.exec(planMarkdown)) !== null) {
        ssotRefs.push({ ref: match[1]!, task_linked: false });
      }
      if (ssotRefs.length > 0) {
        warnings.push('使用了旧式引用格式（R1, R2...），应改为 [SSoT:ProjectName/R1/FeatureName] 格式');
      } else {
        errors.push('缺少 SSoT 需求引用：执行计划中的每个子任务必须引用 polaris.json 需求 ID');
      }
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
      ssotRefs.length > 0 ? 1 : 0,
      ssotRefs.every(r => r.task_linked) ? 1 : 0,
      (typeof goal === 'string' && goal.trim().length > 10) ? 1 : 0,
    ];
    const total = checkpoints.length;
    const covered = checkpoints.reduce((a, b) => a + b, 0);

    return { score: Math.round((covered / total) * 100), total, covered, sections: sectionResults, ssot_refs: ssotRefs, dimensions, errors, warnings };
  }

  app.post('/api/ui/alignment', (req, res) => {
    try {
      const { agent_id, goal, work_logic, workflows, plan_markdown, sections, pilot_project_id, status: reqStatus } = req.body;

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
        pilotProjectId: pilot_project_id || null,
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
        pilot_project_id: r.pilotProjectId,
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
        pilot_project_id: row.pilotProjectId,
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

  // ── Tasks API for Task Board ──────────────────────────────────────
  app.get('/api/ui/tasks', (_req, res) => {
    try {
      const taskRows = db.select().from(tasks).all();
      const depRows = db.select().from(taskDependencies).all();
      const roleRows = db.select().from(agentRoles).all();
      const roleMap = new Map(roleRows.map((r) => [r.agentId, r.role]));

      const depsByTask = new Map<string, string[]>();
      for (const d of depRows) {
        const arr = depsByTask.get(d.taskId) ?? [];
        arr.push(d.dependsOnTaskId);
        depsByTask.set(d.taskId, arr);
      }

      const taskList = taskRows.map((t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        owner_agent_id: t.ownerAgentId,
        owner_role: t.ownerAgentId ? (roleMap.get(t.ownerAgentId) ?? null) : null,
        parent_task_id: t.parentTaskId,
        depends_on: depsByTask.get(t.id) ?? [],
        workflow_stage: t.workflowStage,
        priority: t.priority,
        module: t.module,
        created_at: t.createdAt,
        updated_at: t.updatedAt,
      }));

      // Compute waves for DAG visualization
      const waves = computeWaves(taskList);

      res.json({ tasks: taskList, waves });
    } catch (err) {
      ctx.logger.error({ err }, 'ui tasks list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Compile Gate API ───────────────────────────────────────────────
  app.post('/api/ui/tasks/:id/compile-gate', (req, res) => {
    try {
      const taskId = req.params.id;
      const { checklist_items, verify_evidence_count, quality_gates_passed } = req.body as {
        checklist_items?: number;
        verify_evidence_count?: number;
        quality_gates_passed?: number;
      };

      const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!row) {
        res.status(404).json({ error: 'task_not_found' });
        return;
      }

      const checks = [
        { name: 'structure_14_items', passed: (checklist_items ?? 0) >= 14 },
        { name: 'verify_evidence', passed: (verify_evidence_count ?? 0) >= 3 },
        { name: 'quality_gates', passed: (quality_gates_passed ?? 0) >= 5 },
      ];

      const allPassed = checks.every(c => c.passed);
      const failed = checks.filter(c => !c.passed);

      res.json({
        task_id: taskId,
        passed: allPassed,
        checks,
        failed_count: failed.length,
        message: allPassed
          ? 'compile gate passed — execute tasks can now be claimed'
          : `compile gate failed: ${failed.map(f => f.name).join(', ')}`,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'compile gate error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Polaris SSoT API ─────────────────────────────────────────────
  const POLARISOR_ROOT = join(process.env.HOME ?? '', 'Polarisor');

  app.get('/api/polaris', (_req, res) => {
    try {
      const entries = readdirSync(POLARISOR_ROOT, { withFileTypes: true });
      const projects: unknown[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'ClawBin' || entry.name === '_Polarisor') continue;
        const pjPath = join(POLARISOR_ROOT, entry.name, 'polaris.json');
        try {
          const raw = readFileSync(pjPath, 'utf-8');
          const data = JSON.parse(raw);
          const stat = statSync(pjPath);
          projects.push({ ...data, _file: pjPath, _mtime: stat.mtimeMs });
        } catch {
          /* skip projects without polaris.json */
        }
      }
      res.json({ projects, total: projects.length });
    } catch (err) {
      ctx.logger.error({ err }, 'polaris list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.get('/api/polaris/:project', (req, res) => {
    try {
      const projectName = req.params.project;
      const pjPath = join(POLARISOR_ROOT, projectName, 'polaris.json');
      const raw = readFileSync(pjPath, 'utf-8');
      const data = JSON.parse(raw);
      const stat = statSync(pjPath);
      res.json({ ...data, _file: pjPath, _mtime: stat.mtimeMs });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        res.status(404).json({ error: 'not_found', message: `No polaris.json for project: ${req.params.project}` });
      } else {
        ctx.logger.error({ err }, 'polaris read error');
        res.status(500).json({ error: 'internal' });
      }
    }
  });

  // ── SSoT Annotations API ─────────────────────────────────────────
  app.get('/api/polaris/:project/annotations', (req, res) => {
    try {
      const rows = db.all(sql`SELECT id, project, field_path, author, author_type, text, parent_id, created_at FROM ssot_annotations WHERE project = ${req.params.project} ORDER BY created_at ASC`);
      res.json({ annotations: rows });
    } catch (err) {
      ctx.logger.error({ err }, 'ssot annotations list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/polaris/:project/annotations', (req, res) => {
    try {
      const { field_path, author, author_type, text: annText, parent_id } = req.body as {
        field_path: string; author: string; author_type?: string; text: string; parent_id?: string;
      };
      if (!field_path || !author || !annText) {
        res.status(400).json({ error: 'field_path, author, text required' });
        return;
      }
      const id = randomUUID();
      const now = Date.now();
      db.run(sql`INSERT INTO ssot_annotations (id, project, field_path, author, author_type, text, parent_id, created_at) VALUES (${id}, ${req.params.project}, ${field_path}, ${author}, ${author_type ?? 'user'}, ${annText}, ${parent_id ?? null}, ${now})`);
      res.json({ ok: true, id, created_at: now });
    } catch (err) {
      ctx.logger.error({ err }, 'ssot annotation create error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.delete('/api/polaris/:project/annotations/:id', (req, res) => {
    try {
      db.run(sql`DELETE FROM ssot_annotations WHERE id = ${req.params.id} AND project = ${req.params.project}`);
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'ssot annotation delete error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.delete('/api/polaris/:project/annotations', (req, res) => {
    try {
      const { field_paths } = req.body as { field_paths?: string[] };
      if (field_paths?.length) {
        for (const fp of field_paths) {
          db.run(sql`DELETE FROM ssot_annotations WHERE project = ${req.params.project} AND field_path = ${fp}`);
        }
      } else {
        db.run(sql`DELETE FROM ssot_annotations WHERE project = ${req.params.project}`);
      }
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'ssot annotation batch delete error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Device Resources API ────────────────────────────────────────
  app.get('/api/ui/resources', async (_req, res) => {
    try {
      const os = await import('node:os');
      const cpus = os.cpus();
      const cpuPercent = cpus.reduce((sum, c) => {
        const total = Object.values(c.times).reduce((a, b) => a + b, 0);
        return sum + ((total - c.times.idle) / total) * 100;
      }, 0) / cpus.length;
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;

      const taskRows = db.select().from(tasks).all();

      res.json({
        device: {
          id: os.hostname(),
          hostname: os.hostname(),
          platform: os.platform(),
          totalMemGB: +(totalMem / 1073741824).toFixed(1),
        },
        resource: {
          cpu_percent: +cpuPercent.toFixed(1),
          mem_used_mb: Math.round(usedMem / 1048576),
          mem_total_mb: Math.round(totalMem / 1048576),
          mem_percent: +((usedMem / totalMem) * 100).toFixed(1),
          gpu_mem_used_mb: 0,
          timestamp: new Date().toISOString(),
        },
        tasks: {
          queued: taskRows.filter(t => t.status === 'open').length,
          running: taskRows.filter(t => t.status === 'claimed').length,
          done: taskRows.filter(t => t.status === 'done').length,
          failed: taskRows.filter(t => t.status === 'blocked').length,
        },
        projectCount: (() => {
          try {
            const entries = readdirSync(POLARISOR_ROOT, { withFileTypes: true });
            return entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'ClawBin' && e.name !== '_Polarisor').length;
          } catch { return 0; }
        })(),
        assetCount: 0,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'ui resources error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Ports API ─────────────────────────────────────────────────────
  app.get('/api/ui/ports', async (_req, res) => {
    try {
      const resp = await fetch('http://127.0.0.1:4800/api/ports', { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) { res.json([]); return; }
      const ports = (await resp.json()) as Array<Record<string, unknown>>;
      res.json(ports.map(p => ({
        port: p.port,
        service_name: p.service_name ?? p.service ?? 'unknown',
        project: p.project ?? '',
        device_id: p.device_id ?? '',
        allocated_at: p.allocated_at ?? '',
        last_verified: p.last_verified ?? '',
        status: p.status ?? 'active',
      })));
    } catch {
      res.json([]);
    }
  });

  // ── Ecosystem Services API ────────────────────────────────────────
  type SotServiceRow = Record<string, unknown> & {
    id?: string;
    name?: string;
    status?: string;
    port?: number | null;
  };

  function normalizeSotService(row: SotServiceRow) {
    const port = typeof row.port === 'number' && row.port > 0 ? row.port : null;
    const status = row.status === 'running' || row.status === 'error' || row.status === 'stopped'
      ? row.status
      : 'stopped';
    return {
      id: row.id ?? row.name ?? 'unknown',
      name: row.name ?? row.id ?? 'unknown',
      status,
      pid: row.pid ?? null,
      port,
      url: port ? `http://localhost:${port}` : null,
      device_id: row.device_id ?? '',
      auto_start: Boolean(row.auto_start),
      restart_count: row.restart_count ?? 0,
      max_restarts: row.max_restarts ?? 0,
      started_at: row.started_at ?? null,
      last_health_check: row.last_health_check ?? null,
      is_local: row.is_local !== false,
      cron_schedule: row.cron_schedule ?? null,
      last_exit_code: row.last_exit_code ?? null,
      last_error: row.last_error ?? null,
    };
  }

  async function fetchSotServices() {
    const resp = await fetch(`http://127.0.0.1:${SOTAGENT_API_PORT}/api/services`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) throw new Error(`SOTAgent services HTTP ${resp.status}`);
    const rows = (await resp.json()) as SotServiceRow[];
    return rows.map(normalizeSotService);
  }

  app.get('/api/ui/services', async (_req, res) => {
    try {
      res.json(await fetchSotServices());
    } catch (err) {
      ctx.logger.warn({ err }, 'ui services proxy to SOTAgent failed');
      res.json([]);
    }
  });

  async function proxySotServiceAction(req: express.Request, res: express.Response, action: 'start' | 'stop' | 'restart') {
    const serviceId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!serviceId) {
      res.status(400).json({ ok: false, message: 'service_id_required' });
      return;
    }
    try {
      const upstream = await fetch(
        `http://127.0.0.1:${SOTAGENT_API_PORT}/api/services/${encodeURIComponent(serviceId)}/${action}`,
        { method: 'POST', signal: AbortSignal.timeout(15000) },
      );
      const data = await upstream.json().catch(() => ({ ok: upstream.ok, message: upstream.statusText }));
      res.status(upstream.status).json(data);
    } catch (err: any) {
      ctx.logger.warn({ err, service_id: serviceId, action }, 'ui services action proxy failed');
      res.status(502).json({ ok: false, message: `SOTAgent unavailable: ${err.message}` });
    }
  }

  app.post('/api/ui/services/:id/start', (req, res) => void proxySotServiceAction(req, res, 'start'));
  app.post('/api/ui/services/:id/stop', (req, res) => void proxySotServiceAction(req, res, 'stop'));
  app.post('/api/ui/services/:id/restart', (req, res) => void proxySotServiceAction(req, res, 'restart'));

  // ── Pilot REST API (proxy to PolarClaw) ─────────────────────────────────
  // Pilot is PolarClaw's autonomous project execution system.
  // Hub proxies /api/pilot/* to PolarClaw's API for UI compatibility.
  {
    async function getPolarClawUrl(): Promise<string> {
      try {
        const resp = await fetch('http://127.0.0.1:4800/api/ports', { signal: AbortSignal.timeout(2000) });
        const ports = (await resp.json()) as Array<{ port: number; service_name: string }>;
        const mc = ports.find(p => p.service_name.includes('polarclaw'));
        if (mc) return `http://127.0.0.1:${mc.port}`;
      } catch { /* fall through */ }
      return 'http://127.0.0.1:3910';
    }
    const pilotProxy = async (req: express.Request, res: express.Response) => {
      try {
        const base = await getPolarClawUrl();
        const url = `${base}${req.originalUrl}`;
        const opts: RequestInit = { method: req.method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30000) };
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          opts.body = JSON.stringify(req.body);
        }
        const upstream = await fetch(url, opts);
        const data = await upstream.json();
        res.status(upstream.status).json(data);
      } catch (err: any) {
        ctx.logger.warn({ err }, 'pilot proxy to PolarClaw failed, returning empty');
        if (req.method === 'GET' && req.originalUrl.endsWith('/projects')) {
          res.json({ items: [] });
        } else {
          res.status(502).json({ error: 'PolarClaw unreachable', detail: err.message });
        }
      }
    };

    app.get('/api/pilot/projects', pilotProxy);
    app.get('/api/pilot/projects/:id', pilotProxy);
    app.post('/api/pilot/projects', pilotProxy);
    app.post('/api/pilot/projects/:id/start', pilotProxy);
    app.post('/api/pilot/projects/:id/cancel', pilotProxy);
    app.post('/api/pilot/projects/:id/phases/:idx/status', pilotProxy);

    // ── Pilot Status (read-only BFF for Lobster status dashboard) ────
    {
      interface LobsterStatusRow {
        project_id: string;
        project_name: string;
        state: 'dormant' | 'active' | 'failed' | 'offline';
        last_active_at: string | null;
        current_node: string | null;
        active_targets: number;
        uptime_ms: number | null;
        error?: string;
      }
      interface LobsterEventRow {
        id: string;
        timestamp: string;
        type: string;
        source_project: string;
        target_project?: string;
        severity: 'info' | 'warn' | 'error';
        description: string;
        dedup_key?: string;
      }
      interface PilotStatusCache {
        projects: LobsterStatusRow[];
        recent_events: LobsterEventRow[];
        polarclaw_reachable: boolean;
        last_refresh: string;
        ts: number;
      }

      const KNOWN_PROJECTS = [
        'AutoOffice', 'Clock', 'KnowLever', 'digist', 'tqsdk', 'macbook',
      ];
      const CACHE_TTL_MS = 30_000;
      let statusCache: PilotStatusCache | null = null;

      function offlineFallback(): PilotStatusCache {
        return {
          projects: KNOWN_PROJECTS.map(name => ({
            project_id: name.toLowerCase(),
            project_name: name,
            state: 'offline' as const,
            last_active_at: null,
            current_node: null,
            active_targets: 0,
            uptime_ms: null,
            error: 'PolarClaw SDK unreachable',
          })),
          recent_events: [],
          polarclaw_reachable: false,
          last_refresh: new Date().toISOString(),
          ts: Date.now(),
        };
      }

      async function refreshPilotStatus(): Promise<PilotStatusCache> {
        if (statusCache && Date.now() - statusCache.ts < CACHE_TTL_MS) {
          return statusCache;
        }
        try {
          const base = await getPolarClawUrl();
          const [statusResp, eventsResp] = await Promise.all([
            fetch(`${base}/api/sdk/lobsters`, { signal: AbortSignal.timeout(5000) }),
            fetch(`${base}/api/sdk/lobsters/events?limit=50`, { signal: AbortSignal.timeout(5000) }),
          ]);
          if (!statusResp.ok) throw new Error(`lobsters status ${statusResp.status}`);
          const statusData = (await statusResp.json()) as { items?: LobsterStatusRow[] };
          const projects = statusData.items ?? [];
          let events: LobsterEventRow[] = [];
          if (eventsResp.ok) {
            const evData = (await eventsResp.json()) as { items?: LobsterEventRow[] };
            events = evData.items ?? [];
          }
          statusCache = {
            projects,
            recent_events: events,
            polarclaw_reachable: true,
            last_refresh: new Date().toISOString(),
            ts: Date.now(),
          };
        } catch {
          statusCache = offlineFallback();
        }
        return statusCache;
      }

      app.get('/api/ui/pilot-status', async (_req, res) => {
        const data = await refreshPilotStatus();
        res.json(data);
      });

      app.get('/api/ui/pilot-status/:project', async (req, res) => {
        const data = await refreshPilotStatus();
        const proj = data.projects.find(
          p => p.project_id === req.params.project || p.project_name === req.params.project,
        );
        if (!proj) {
          res.status(404).json({ error: 'project_not_found', available: data.projects.map(p => p.project_id) });
          return;
        }
        const events = data.recent_events.filter(
          e => e.source_project === proj.project_id || e.target_project === proj.project_id
              || e.source_project === proj.project_name || e.target_project === proj.project_name,
        );
        res.json({ ...proj, events });
      });
    }

    // ── PolarClaw Chat Sessions (via Pending Prompts) ──────────────────
    const polarClawSessions = new Map<string, {
      model: string;
      messages: Array<{ role: string; content: string }>;
      createdAt: number;
    }>();
    const polarClawForwardedPrompts = new Set<string>();

    setInterval(() => {
      const cutoff = Date.now() - 4 * 3600_000;
      const cutoffDate = new Date(cutoff);
      for (const [k, v] of polarClawSessions) {
        if (v.createdAt < cutoff) {
          polarClawSessions.delete(k);
        }
      }
      if (polarClawForwardedPrompts.size > 5000) polarClawForwardedPrompts.clear();

      const staleDbSessions = db.select({ agentId: sessions.agentId })
        .from(sessions)
        .where(and(
          sql`${sessions.agentId} LIKE 'polarclaw-chat-%'`,
          lte(sessions.lastPingAt, cutoffDate),
        ))
        .all();
      for (const s of staleDbSessions) {
        db.update(uiPrompts)
          .set({ answer: '[auto-closed: session expired]', answeredAt: new Date() })
          .where(and(eq(uiPrompts.agentId, s.agentId), isNull(uiPrompts.answeredAt)))
          .run();
        db.delete(sessions).where(eq(sessions.agentId, s.agentId)).run();
        notifyUiSse('session_ended', { session_id: s.agentId, reason: 'stale_cleanup' });
      }
    }, 600_000);

    const polarClawModelsHandler = async (_req: express.Request, res: express.Response) => {
      try {
        const base = await getPolarClawUrl();
        const resp = await fetch(`${base}/api/models`, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`PolarClaw /api/models: ${resp.status}`);
        res.json(await resp.json());
      } catch (err: any) {
        ctx.logger.warn({ err: err.message }, 'polarclaw models fetch failed');
        res.json({ models: ['auto'], intent_models: {} });
      }
    };
    app.get('/api/ui/polarclaw/models', polarClawModelsHandler);

    const polarClawStartHandler = (req: express.Request, res: express.Response) => {
      try {
        const { model } = req.body as { model?: string };
        const sessionId = `polarclaw-chat-${randomUUID().slice(0, 8)}`;
        const selectedModel = model || 'auto';

        polarClawSessions.set(sessionId, {
          model: selectedModel,
          messages: [],
          createdAt: Date.now(),
        });

        const id = randomUUID();
        const now = new Date();
        const modelLabel = selectedModel === 'auto' ? '自动路由' : selectedModel;
        const promptText = `**PolarClaw 对话** · 模型: \`${modelLabel}\`\n\n请输入你的问题。`;

        db.insert(uiPrompts).values({
          id,
          prompt: promptText,
          optionsJson: JSON.stringify([]),
          answer: null,
          agentId: sessionId,
          createdAt: now,
          answeredAt: null,
        }).run();

        const sessionRow = db.select().from(sessions).where(eq(sessions.agentId, sessionId)).get();
        if (!sessionRow) {
          db.insert(sessions).values({
            mcpSessionId: randomUUID(),
            agentId: sessionId,
            displayName: `PolarClaw · ${modelLabel}`,
            createdAt: now,
            updatedAt: now,
            lastPingAt: now,
          }).run();
        }

        notifyUiSse('prompt_created', { id, agent_id: sessionId, superseded: 0 });
        res.json({ session_id: sessionId, prompt_id: id, model: selectedModel });
      } catch (err) {
        ctx.logger.error({ err }, 'polarclaw start error');
        res.status(500).json({ error: 'internal' });
      }
    };
    app.post('/api/ui/polarclaw/start', polarClawStartHandler);

    const polarClawForwardHandler = async (req: express.Request, res: express.Response) => {
      const promptIdParam = req.params.promptId;
      const pid = Array.isArray(promptIdParam) ? promptIdParam[0] : promptIdParam;
      try {
        if (!pid) {
          res.status(400).json({ error: 'prompt_id_required' });
          return;
        }
        if (polarClawForwardedPrompts.has(pid)) {
          res.json({ prompt_id: pid, content: '[already forwarded]', model: 'skip' });
          return;
        }
        polarClawForwardedPrompts.add(pid);

        const promptRow = db.select().from(uiPrompts).where(eq(uiPrompts.id, pid)).get();
        if (!promptRow || !promptRow.agentId?.startsWith('polarclaw-chat-')) {
          res.status(404).json({ error: 'not a polarclaw session prompt' });
          return;
        }

        const sessionId = promptRow.agentId;
        let session = polarClawSessions.get(sessionId);
        if (!session) {
          session = { model: 'auto', messages: [], createdAt: Date.now() };
          polarClawSessions.set(sessionId, session);
        }

        const userMessage = promptRow.answer ?? '';
        session.messages.push({ role: 'user', content: userMessage });

        const base = await getPolarClawUrl();

        const upstream = await fetch(`${base}/api/agent/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMessage,
            conversation_id: sessionId,
          }),
          signal: AbortSignal.timeout(120_000),
        });

        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => 'unknown');
          throw new Error(`PolarClaw /api/agent/chat: ${upstream.status} — ${errText}`);
        }

        const chatResult = (await upstream.json()) as { content: string; conversation_id?: string };

        const DEAD_SESSION_PATTERNS = ['抱歉，处理消息时出错了', '处理消息时出错', 'handleMessage error'];
        const isDead = DEAD_SESSION_PATTERNS.some(p => chatResult.content.includes(p));

        if (isDead) {
          ctx.logger.warn({ sessionId }, 'polarclaw session appears dead, auto-closing');
          polarClawSessions.delete(sessionId);
          db.update(uiPrompts)
            .set({ answer: '[auto-closed: PolarClaw 会话已失效]', answeredAt: new Date() })
            .where(and(eq(uiPrompts.agentId, sessionId), isNull(uiPrompts.answeredAt)))
            .run();
          db.delete(sessions).where(eq(sessions.agentId, sessionId)).run();
          notifyUiSse('session_ended', { session_id: sessionId, reason: 'dead_session' });
          res.json({ prompt_id: pid, content: chatResult.content, model: session.model, closed: true });
          return;
        }

        session.messages.push({ role: 'assistant', content: chatResult.content });

        const replyId = randomUUID();
        const now = new Date();
        const modelLabel = session.model === 'auto' ? 'Agent' : session.model;
        const replyPrompt = `${chatResult.content}\n\n---\n*PolarClaw · ${modelLabel}*`;

        db.insert(uiPrompts).values({
          id: replyId,
          prompt: replyPrompt,
          optionsJson: JSON.stringify([]),
          answer: null,
          agentId: sessionId,
          createdAt: now,
          answeredAt: null,
        }).run();

        db.update(sessions)
          .set({ lastPingAt: now })
          .where(eq(sessions.agentId, sessionId))
          .run();

        notifyUiSse('prompt_created', { id: replyId, agent_id: sessionId, superseded: 0 });
        res.json({ prompt_id: replyId, content: chatResult.content, model: session.model });
      } catch (err: any) {
        ctx.logger.error({ err }, 'polarclaw forward error');

        if (!pid) {
          res.status(502).json({ error: 'polarclaw_error', detail: err.message, closed: true });
          return;
        }
        const promptRow = db.select().from(uiPrompts).where(eq(uiPrompts.id, pid)).get();
        const sid = promptRow?.agentId;
        if (sid) {
          polarClawSessions.delete(sid);
          db.update(uiPrompts)
            .set({ answer: `[auto-closed: ${err.message}]`, answeredAt: new Date() })
            .where(and(eq(uiPrompts.agentId, sid), isNull(uiPrompts.answeredAt)))
            .run();
          db.delete(sessions).where(eq(sessions.agentId, sid)).run();
          notifyUiSse('session_ended', { session_id: sid, reason: 'forward_error' });
        }
        res.status(502).json({ error: 'polarclaw_error', detail: err.message, closed: true });
      }
    };
    app.post('/api/ui/polarclaw/forward/:promptId', polarClawForwardHandler);

    const polarClawDeleteSessionHandler = (req: express.Request, res: express.Response) => {
      const sessionIdParam = req.params.sessionId;
      const sessionId = Array.isArray(sessionIdParam) ? sessionIdParam[0] : sessionIdParam;
      if (!sessionId) {
        res.status(400).json({ error: 'session_id_required' });
        return;
      }
      polarClawSessions.delete(sessionId);
      // Close any pending prompts for this session
      db.update(uiPrompts)
        .set({ answer: '[session ended]', answeredAt: new Date() })
        .where(and(eq(uiPrompts.agentId, sessionId), isNull(uiPrompts.answeredAt)))
        .run();
      // Clean up session registry
      db.delete(sessions).where(eq(sessions.agentId, sessionId)).run();
      notifyUiSse('session_ended', { session_id: sessionId });
      res.json({ ok: true });
    };
    app.delete('/api/ui/polarclaw/session/:sessionId', polarClawDeleteSessionHandler);
  }

  // ── Merge API (Main Agent branches) ────────────────────────────────
  app.get('/api/ui/merge/branches', async (_req, res) => {
    try {
      const { execSync } = await import('child_process');
      const cwd = process.env.PC_PROJECT_DIR ?? join(POLARISOR_ROOT, 'PolarCopilot');
      const raw = execSync('git branch -r --format="%(refname:short)|%(committerdate:iso8601)|%(subject)"', { cwd, encoding: 'utf-8' });
      const branches = raw.trim().split('\n')
        .map(line => { const [name, date, ...msg] = line.split('|'); return { name: name?.replace('origin/', '') ?? '', date, message: msg.join('|') }; })
        .filter(b => b.name.startsWith('agent/'));
      const current = execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim();
      res.json({ branches, current_branch: current });
    } catch (err) {
      ctx.logger.error({ err }, 'merge branches error');
      res.status(500).json({ error: 'failed to list branches' });
    }
  });

  app.post('/api/ui/merge/execute', async (req, res) => {
    try {
      const { execSync } = await import('child_process');
      const cwd = process.env.PC_PROJECT_DIR ?? join(POLARISOR_ROOT, 'PolarCopilot');
      const branch = req.body?.branch;
      if (!branch || typeof branch !== 'string' || /[;&|`$]/.test(branch)) {
        res.status(400).json({ error: 'invalid branch name' });
        return;
      }
      try {
        const log = execSync(`git merge origin/${branch} --no-edit 2>&1`, { cwd, encoding: 'utf-8', timeout: 30000 });
        notifyUiSse('prompt_created', { type: 'merge_complete', branch });
        res.json({ ok: true, log });
      } catch (mergeErr: any) {
        const output = mergeErr.stdout ?? mergeErr.stderr ?? mergeErr.message;
        if (output?.includes('CONFLICT')) {
          execSync('git merge --abort 2>/dev/null || true', { cwd, encoding: 'utf-8' });
          res.json({ ok: false, conflict: true, log: output });
        } else {
          res.json({ ok: false, conflict: false, error: output });
        }
      }
    } catch (err: any) {
      ctx.logger.error({ err }, 'merge execute error');
      res.status(500).json({ error: err.message });
    }
  });

  // ── SSoT polaris.json PATCH ───────────────────────────────────────
  app.patch('/api/polaris/:project', (req, res) => {
    try {
      const projectName = req.params.project;
      const pjPath = join(POLARISOR_ROOT, projectName, 'polaris.json');
      let existing: Record<string, unknown>;
      try {
        existing = JSON.parse(readFileSync(pjPath, 'utf-8'));
      } catch (err: any) {
        if (err?.code === 'ENOENT') { res.status(404).json({ error: 'not_found' }); return; }
        throw err;
      }
      const updates = req.body as Record<string, unknown>;
      const safeKeys = ['description', 'tier', 'status', 'version', 'tech', 'requirements'];
      const VALID_TEST_STATUS = ['passed', 'failed', 'not_tested', 'stub'];

      for (const key of Object.keys(updates)) {
        if (!safeKeys.includes(key)) continue;
        if (key === 'requirements' && Array.isArray(updates[key]) && Array.isArray(existing[key])) {
          const existingReqs = existing[key] as Array<Record<string, unknown>>;
          const updateReqs = updates[key] as Array<Record<string, unknown>>;
          for (const uReq of updateReqs) {
            const idx = existingReqs.findIndex(r => r.id === uReq.id);
            if (idx >= 0) {
              if (Array.isArray(uReq.features) && Array.isArray(existingReqs[idx]!.features)) {
                const existFeats = existingReqs[idx]!.features as Array<Record<string, unknown>>;
                for (const uFeat of uReq.features as Array<Record<string, unknown>>) {
                  if (uFeat.test_status !== undefined && !VALID_TEST_STATUS.includes(uFeat.test_status as string)) {
                    res.status(400).json({ error: 'invalid_test_status', message: `test_status must be one of: ${VALID_TEST_STATUS.join(', ')}`, feature: uFeat.name });
                    return;
                  }
                  if (uFeat.status === 'done' && uFeat.test_status !== undefined && uFeat.test_status !== 'passed') {
                    res.status(400).json({ error: 'test_status_required', message: 'status=done 时 test_status 必须为 passed', feature: uFeat.name });
                    return;
                  }
                  const fi = existFeats.findIndex(f => f.name === uFeat.name);
                  if (fi >= 0) {
                    const merged = { ...existFeats[fi]!, ...uFeat };
                    if (merged.status === 'done' && merged.test_status !== undefined && merged.test_status !== 'passed') {
                      res.status(400).json({ error: 'test_status_required', message: 'status=done 时 test_status 必须为 passed', feature: uFeat.name });
                      return;
                    }
                    Object.assign(existFeats[fi]!, uFeat);
                  } else {
                    existFeats.push(uFeat);
                  }
                }
                delete uReq.features;
              }
              Object.assign(existingReqs[idx]!, uReq);
            } else {
              existingReqs.push(uReq);
            }
          }
        } else {
          existing[key] = updates[key];
        }
      }
      writeFileSync(pjPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
      const updatedKeys = Object.keys(updates).filter(k => safeKeys.includes(k));
      notifyUiSse('ssot_updated', { project: projectName, updated: updatedKeys });
      res.json({ ok: true, updated: updatedKeys });
    } catch (err) {
      ctx.logger.error({ err }, 'polaris patch error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // ── Project Ownership API (persisted in SQLite) ────────────────────
  app.post('/api/ownership', (req, res) => {
    const { agent_id, project_name, project_path } = req.body ?? {};
    if (!agent_id || !project_name) { res.status(400).json({ error: 'agent_id and project_name required' }); return; }
    const now = new Date();
    db.insert(projectOwnership).values({
      projectName: String(project_name),
      agentId: String(agent_id),
      projectPath: String(project_path ?? ''),
      registeredAt: now,
    }).onConflictDoUpdate({
      target: projectOwnership.projectName,
      set: { agentId: String(agent_id), projectPath: String(project_path ?? ''), registeredAt: now },
    }).run();
    res.json({ ok: true, project_name, agent_id });
  });

  app.get('/api/ownership', (_req, res) => {
    const now = Date.now();
    const rows = db.select().from(projectOwnership).all();
    const list = rows.map((row) => {
      const sessionRow = db.select().from(sessions).where(eq(sessions.agentId, row.agentId)).get();
      const alive = sessionRow?.lastPingAt
        ? now - new Date(sessionRow.lastPingAt).getTime() < ALIVE_THRESHOLD_MS_CONST
        : false;
      return {
        project_name: row.projectName,
        agent_id: row.agentId,
        project_path: row.projectPath,
        registered_at: row.registeredAt?.toISOString() ?? '',
        alive,
      };
    });
    res.json(list);
  });

  app.get('/api/ownership/:project', (req, res) => {
    const row = db.select().from(projectOwnership).where(eq(projectOwnership.projectName, req.params.project!)).get();
    if (!row) { res.status(404).json({ error: 'not_found' }); return; }
    const now = Date.now();
    const sessionRow = db.select().from(sessions).where(eq(sessions.agentId, row.agentId)).get();
    const alive = sessionRow?.lastPingAt
      ? now - new Date(sessionRow.lastPingAt).getTime() < ALIVE_THRESHOLD_MS_CONST
      : false;
    res.json({
      project_name: row.projectName,
      agent_id: row.agentId,
      project_path: row.projectPath,
      registered_at: row.registeredAt?.toISOString() ?? '',
      alive,
    });
  });

  app.delete('/api/ownership/:project', (req, res) => {
    const agentId = req.headers['x-agent-id'] ?? req.body?.agent_id;
    const row = db.select().from(projectOwnership).where(eq(projectOwnership.projectName, req.params.project!)).get();
    if (!row) { res.json({ ok: true, released: false }); return; }
    if (agentId && row.agentId !== String(agentId)) { res.status(403).json({ error: 'not_owner' }); return; }
    db.delete(projectOwnership).where(eq(projectOwnership.projectName, req.params.project!)).run();
    res.json({ ok: true, released: true });
  });

  app.get('/favicon.ico', (_req, res) => { res.status(204).end(); });

  const UI_TO_PC: Record<string, string> = {
    '/ui': '/pc/',
    '/ui/prompts': '/pc/prompts',
    '/ui/tasks': '/pc/tasks',
    '/ui/project': '/pc/',
    '/ui/pilot': '/pc/pilot',
    '/ui/chat': '/pc/ssot',
    '/ui/yolo': '/pc/yolo',
    '/ui/ssot': '/pc/ssot',
    '/ui/checkup-events': '/pc/checkup-events',
  };
  for (const [from, to] of Object.entries(UI_TO_PC)) {
    app.get(from, (_req, res) => { res.redirect(301, to); });
  }

  // ── Checkup widget + P1 embed landing pages (/embed/:project) ─────
  const hubStaticRoot = join(process.env.HOME ?? '', 'Polarisor', 'PolarCopilot', 'hub', 'static');
  const checkupWidgetDir = join(hubStaticRoot, 'checkup-widget');
  const checkupEmbedDir = join(hubStaticRoot, 'checkup-embed');
  if (existsSync(checkupWidgetDir)) {
    app.use('/checkup-widget', express.static(checkupWidgetDir, { etag: false, lastModified: false, maxAge: 0 }));
  }
  app.get('/embed/:project', (req, res) => {
    const project = String(req.params.project ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!project) {
      res.status(400).json({ ok: false, error: 'invalid_project' });
      return;
    }
    const file = join(checkupEmbedDir, `${project}.html`);
    if (!existsSync(file)) {
      res.status(404).json({ ok: false, error: 'embed_not_found', project });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(file);
  });

  // ── PolarCopilot Web SPA (/pc/*) ────────────────────────────────
  const pcWebDist = join(process.env.HOME ?? '', 'Polarisor', 'PolarCopilot', 'web', 'dist');
  if (existsSync(pcWebDist)) {
    app.use('/pc', express.static(pcWebDist, { etag: false, lastModified: false, maxAge: 0 }));
    app.get(/^\/pc\/.*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(pcWebDist, 'index.html'));
    });
  }

  // ── Prolusion Plans API ───────────────────────────────────────────
  function serializeProlusion(row: typeof prolusionPlans.$inferSelect, full = false) {
    const base = {
      id: row.id,
      title: row.title,
      goal: row.goal,
      status: row.status,
      current_stage: row.currentStage,
      ssot_refs: JSON.parse(row.ssotRefs ?? '[]'),
      created_by: row.createdBy ?? null,
      created_at: row.createdAt?.toISOString() ?? new Date().toISOString(),
      updated_at: row.updatedAt?.toISOString() ?? new Date().toISOString(),
      completed_at: row.completedAt?.toISOString() ?? null,
    };
    if (!full) return base;
    return {
      ...base,
      demand_analysis: JSON.parse(row.demandAnalysis ?? '{}'),
      code_mapping: JSON.parse(row.codeMapping ?? '{}'),
      tech_overview: JSON.parse(row.techOverview ?? '{}'),
      task_allocation: JSON.parse(row.taskAllocation ?? '[]'),
    };
  }

  // List all prolusion plans
  app.get('/api/ui/prolusion', (_req, res) => {
    try {
      const rows = db.select().from(prolusionPlans).orderBy(sql`created_at DESC`).all();
      res.json(rows.map((r) => serializeProlusion(r)));
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion list error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Get single prolusion plan (full detail)
  app.get('/api/ui/prolusion/:id', (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).get();
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      res.json(serializeProlusion(row, true));
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion get error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Create prolusion plan
  app.post('/api/ui/prolusion', (req, res) => {
    try {
      const { title, goal, created_by, ssot_refs } = req.body as {
        title?: string; goal?: string; created_by?: string; ssot_refs?: string[];
      };
      if (!title || !goal) { res.status(400).json({ error: 'title and goal required' }); return; }
      const id = randomUUID();
      const now = new Date();
      db.insert(prolusionPlans).values({
        id,
        title: String(title),
        goal: String(goal),
        status: 'stage_1',
        currentStage: 1,
        demandAnalysis: '{}',
        codeMapping: '{}',
        techOverview: '{}',
        taskAllocation: '[]',
        ssotRefs: JSON.stringify(ssot_refs ?? []),
        createdBy: created_by ?? 'user',
        createdAt: now,
        updatedAt: now,
      }).run();
      notifyUiSse('prolusion_created', { id, title, status: 'stage_1', current_stage: 1 });
      res.json({ id, title, status: 'stage_1', current_stage: 1 });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion create error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Update prolusion plan fields
  app.patch('/api/ui/prolusion/:id', (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).get();
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      const { title, goal, demand_analysis, code_mapping, tech_overview, task_allocation, ssot_refs } = req.body as {
        title?: string; goal?: string;
        demand_analysis?: unknown; code_mapping?: unknown; tech_overview?: unknown; task_allocation?: unknown;
        ssot_refs?: string[];
      };
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (title !== undefined) updates.title = String(title);
      if (goal !== undefined) updates.goal = String(goal);
      if (demand_analysis !== undefined) updates.demandAnalysis = JSON.stringify(demand_analysis);
      if (code_mapping !== undefined) updates.codeMapping = JSON.stringify(code_mapping);
      if (tech_overview !== undefined) updates.techOverview = JSON.stringify(tech_overview);
      if (task_allocation !== undefined) updates.taskAllocation = JSON.stringify(task_allocation);
      if (ssot_refs !== undefined) updates.ssotRefs = JSON.stringify(ssot_refs);
      db.update(prolusionPlans).set(updates).where(eq(prolusionPlans.id, req.params.id!)).run();
      notifyUiSse('prolusion_updated', { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion update error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Delete prolusion plan
  app.delete('/api/ui/prolusion/:id', (req, res) => {
    try {
      db.delete(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).run();
      notifyUiSse('prolusion_deleted', { id: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion delete error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Advance prolusion to next stage
  app.post('/api/ui/prolusion/:id/advance', (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).get();
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      const nextStage = Math.min(row.currentStage + 1, 4);
      const nextStatus = nextStage === 4 ? 'stage_4' : `stage_${nextStage}`;
      db.update(prolusionPlans).set({ currentStage: nextStage, status: nextStatus, updatedAt: new Date() })
        .where(eq(prolusionPlans.id, req.params.id!)).run();
      notifyUiSse('prolusion_updated', { id: req.params.id, current_stage: nextStage, status: nextStatus });
      res.json({ current_stage: nextStage, status: nextStatus });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion advance error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Complete prolusion plan
  app.post('/api/ui/prolusion/:id/complete', (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).get();
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }
      const now = new Date();
      db.update(prolusionPlans).set({ status: 'completed', completedAt: now, updatedAt: now })
        .where(eq(prolusionPlans.id, req.params.id!)).run();
      notifyUiSse('prolusion_updated', { id: req.params.id, status: 'completed' });
      res.json({ ok: true });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion complete error');
      res.status(500).json({ error: 'internal' });
    }
  });

  // Dispatch prolusion tasks to hub task board
  app.post('/api/ui/prolusion/:id/dispatch', (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id!)).get();
      if (!row) { res.status(404).json({ error: 'not_found' }); return; }

      const taskAlloc = JSON.parse(row.taskAllocation ?? '[]') as Array<{
        title: string; description: string; agent_type?: string; priority?: number; depends_on?: string[]; module?: string;
      }>;

      if (!taskAlloc.length) {
        res.status(400).json({ error: 'no tasks to dispatch — add tasks in stage 4 first' });
        return;
      }

      // Find available slave agents
      const now = Date.now();
      const SLAVE_ALIVE_MS = 60_000;
      const allSessions = db.select().from(sessions).all();
      const aliveSlaves = allSessions.filter((s) =>
        s.agentType === 'slave' &&
        s.lastPingAt &&
        now - new Date(s.lastPingAt).getTime() < SLAVE_ALIVE_MS,
      );

      const createdTaskIds: string[] = [];
      const assignments: Array<{ task_id: string; slave_id: string; slave_name: string | null; task_title: string }> = [];
      let slaveIdx = 0;

      for (const t of taskAlloc) {
        const taskId = randomUUID();
        const taskNow = new Date();
        const slave = aliveSlaves[slaveIdx % Math.max(aliveSlaves.length, 1)];
        const assignedSlave = aliveSlaves.length > 0 ? slave : null;
        if (aliveSlaves.length > 0) slaveIdx++;

        db.insert(tasks).values({
          id: taskId,
          status: assignedSlave ? 'assigned' : 'open',
          ownerAgentId: assignedSlave?.agentId ?? null,
          parentTaskId: null,
          workflowStage: 'prolusion',
          priority: t.priority ?? 50,
          title: t.title,
          description: t.description,
          module: t.module ?? null,
          createdAt: taskNow,
          updatedAt: taskNow,
        }).run();

        createdTaskIds.push(taskId);
        if (assignedSlave) {
          assignments.push({
            task_id: taskId,
            slave_id: assignedSlave.agentId,
            slave_name: assignedSlave.displayName ?? null,
            task_title: t.title,
          });
          // Notify slave via SSE
          if (publisher) {
            publisher.publish({
              sourceAgentId: 'hub-system',
              topic: `${assignedSlave.agentId}.inbox`,
              payload: {
                type: 'task_assigned',
                task_id: taskId,
                title: t.title,
                description: t.description,
                priority: t.priority ?? 50,
                module: t.module,
                source: 'prolusion',
                plan_id: row.id,
              },
            });
          }
        }
      }

      db.update(prolusionPlans).set({ status: 'dispatched', updatedAt: new Date() })
        .where(eq(prolusionPlans.id, req.params.id!)).run();
      notifyUiSse('prolusion_dispatched', { id: req.params.id, task_count: createdTaskIds.length });

      res.json({
        ok: true,
        task_ids: createdTaskIds,
        assigned: assignments.length,
        unassigned: createdTaskIds.length - assignments.length,
        assignments,
      });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion dispatch error');
      res.status(500).json({ error: 'internal' });
    }
  });

  app.post('/api/ui/prolusion/:id/ai-plan', async (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id)).get();
      if (!row) { res.status(404).json({ error: 'plan not found' }); return; }

      const demandAnalysis = JSON.parse(row.demandAnalysis || '{}');
      if (!demandAnalysis.objectives?.length && !demandAnalysis.scope) {
        res.status(400).json({ error: 'demand_analysis is empty, fill Stage 1 first' });
        return;
      }

      const polarisDir = homedir() + '/Polarisor';
      const polarisData: Array<{ name: string; description: string; tier?: string; requirements: unknown[] }> = [];
      if (existsSync(polarisDir)) {
        for (const dir of readdirSync(polarisDir)) {
          const pj = `${polarisDir}/${dir}/polaris.json`;
          if (existsSync(pj)) {
            try {
              const data = JSON.parse(readFileSync(pj, 'utf-8'));
              polarisData.push({ name: data.name, description: data.description, tier: data.tier, requirements: data.requirements || [] });
            } catch { /* skip */ }
          }
        }
      }

      const mode = (req.body as any)?.mode || 'auto';
      const modeInstruction = mode === 'solo-only'
        ? "必须采用【仅1个 Solo】的形式：task_allocation 只能有1个任务，agent_type=\"solo\"，由 Solo 独立完成所有工作。"
        : mode === 'solo-slaves'
        ? "必须采用【1个 Solo + 多个 Slave】的形式：Solo 负责核心架构/协调，多个 Slave 负责具体模块开发。"
        : "请根据需求复杂程度，智能选择（1个 Solo + 多个 Slave，或仅1个 Solo）。";

      // Compact SSoT: only name, tier, first 3 requirements
      const compactSSOT = polarisData.slice(0, 3).map(p => {
        const reqs = (p.requirements as Array<{id: string; need: string}>).slice(0, 3).map(r => `${r.id}: ${r.need}`).join('; ');
        return `- ${p.name}(${p.tier || '?'}): ${(p.description ?? '').slice(0, 80)}${reqs ? ` | 需求: ${reqs}` : ''}`;
      }).join('\n');

      // Compact demand analysis
      const da = demandAnalysis as any;
      const compactDA = [
        da.scope ? `范围: ${da.scope}` : '',
        ...(da.objectives ?? []).slice(0, 5).map((o: string, i: number) => `${i + 1}. ${o}`),
        ...(da.constraints ?? []).slice(0, 3).map((c: string) => `约束: ${c}`),
      ].filter(Boolean).join('\n');

      const systemPrompt = `你是 Polarisor 生态的技术规划助手，根据 Stage 1 需求分析自动生成后续 3 个阶段。

## 生态 SSoT（摘要）
${compactSSOT}

## 规划: ${row.title}
目标: ${row.goal}

## Stage 1 需求分析
${compactDA}

## 任务包规则
${modeInstruction}
agent_type 必须是 "solo" 或 "slave"。

## 输出 JSON（严格格式，不含其他内容）:
{
  "code_mapping": { "modules": [{ "name": "模块名", "description": "描述", "files": ["file.ts"] }], "dependencies": ["A → B"], "notes": "" },
  "tech_overview": { "risks": [{ "description": "风险", "severity": "low|medium|high" }], "decisions": [{ "question": "问题", "choice": "选择", "rationale": "理由" }], "notes": "" },
  "task_allocation": [{ "title": "任务", "description": "详细描述", "priority": 90, "module": "模块", "agent_type": "solo|slave" }]
}`;

      const polarClawPort = await (async () => {
        try {
          const portsRes = await fetch('http://127.0.0.1:4800/api/ports', { signal: AbortSignal.timeout(3000) });
          const ports = await portsRes.json() as Array<{ port: number; service?: string; project?: string }>;
          const mc = ports.find(p => p.service === 'polarclaw-web' || (p.project || '').toLowerCase().includes('polarclaw'));
          return mc?.port ?? 3910;
        } catch { return 3910; }
      })();

      const chatRes = await fetch(`http://127.0.0.1:${polarClawPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: 'user', content: '根据需求分析，生成代码映射、技术概览、任务分配三个阶段的完整内容。' }],
          context_query: `${row.title} ${row.goal}`,
          max_tokens: 8192,
        }),
        signal: AbortSignal.timeout(900_000), // 15 minutes
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        res.status(502).json({ error: `PolarClaw error: ${chatRes.status} ${errText}` });
        return;
      }

      const chatData = await chatRes.json() as { content: string; model?: string };
      let generated: { code_mapping?: unknown; tech_overview?: unknown; task_allocation?: unknown } = {};
      try {
        const jsonMatch = chatData.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) generated = JSON.parse(jsonMatch[0]);
      } catch {
        res.status(500).json({ error: 'LLM output parse failed', raw: chatData.content.slice(0, 500) });
        return;
      }

      const now = new Date();
      db.update(prolusionPlans)
        .set({
          codeMapping: JSON.stringify(generated.code_mapping || {}),
          techOverview: JSON.stringify(generated.tech_overview || {}),
          taskAllocation: JSON.stringify(generated.task_allocation || []),
          currentStage: 4,
          status: 'stage_4',
          updatedAt: now,
        })
        .where(eq(prolusionPlans.id, req.params.id))
        .run();

      notifyUiSse('prolusion_updated', { id: req.params.id });
      res.json({ ok: true, model: chatData.model, code_mapping: generated.code_mapping, tech_overview: generated.tech_overview, task_allocation: generated.task_allocation });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion ai-plan error');
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/ui/prolusion/:id/generate-prompts', async (req, res) => {
    try {
      const row = db.select().from(prolusionPlans).where(eq(prolusionPlans.id, req.params.id)).get();
      if (!row) { res.status(404).json({ error: 'plan not found' }); return; }

      const taskAllocation = JSON.parse(row.taskAllocation || '[]') as Array<{
        title: string; description: string; agent_type?: string; priority?: number;
        depends_on?: string[]; module?: string;
      }>;
      if (taskAllocation.length === 0) {
        res.status(400).json({ error: 'no tasks in task_allocation' });
        return;
      }

      const demandAnalysis = JSON.parse(row.demandAnalysis || '{}');
      const codeMapping = JSON.parse(row.codeMapping || '{}') as { modules?: Array<{name: string; description: string}>; dependencies?: string[] };
      const techOverview = JSON.parse(row.techOverview || '{}') as { risks?: Array<{description: string; severity: string}>; decisions?: Array<{question: string; choice: string}> };

      // Compact SSoT: only name + description, max 3 projects
      const polarisData = (() => {
        const polarisDir = homedir() + '/Polarisor';
        const projects: Array<{ name: string; description: string }> = [];
        if (existsSync(polarisDir)) {
          for (const dir of readdirSync(polarisDir)) {
            const pj = `${polarisDir}/${dir}/polaris.json`;
            if (existsSync(pj)) {
              try {
                const data = JSON.parse(readFileSync(pj, 'utf-8'));
                projects.push({ name: data.name, description: (data.description ?? '').slice(0, 100) });
              } catch { /* skip */ }
            }
          }
        }
        return projects.slice(0, 3);
      })();

      const systemPrompt = `你是 Polarisor 生态的任务规划助手，根据规划信息为每个任务生成 Agent Prompt。

## 生态项目
${polarisData.map(p => `- ${p.name}: ${p.description}`).join('\n')}

## 规划: ${row.title}
目标: ${row.goal}

需求分析摘要: ${(demandAnalysis.objectives ?? []).slice(0, 5).join(' | ') || demandAnalysis.scope || ''}

模块: ${(codeMapping.modules ?? []).slice(0, 8).map((m) => `${m.name}(${m.description?.slice(0, 50) ?? ''})`).join(', ')}

风险: ${(techOverview.risks ?? []).slice(0, 5).map((r) => `[${r.severity}]${r.description?.slice(0, 60) ?? ''}`).join('; ')}

## 任务分配
${taskAllocation.map((t, i) => `${i + 1}. [${t.agent_type || 'solo'}] ${t.title}: ${t.description}${t.module ? ` (模块: ${t.module})` : ''}`).join('\n')}

## 输出格式（JSON 数组，不含其他内容）
[{ "task_index": 0, "task_title": "...", "agent_type": "solo|slave", "prompt": "完整的中文 Agent 执行 Prompt，包含：目标、验收标准、涉及文件、技术约束" }]`;

      const polarClawPort = await (async () => {
        try {
          const portsRes = await fetch('http://127.0.0.1:4800/api/ports', { signal: AbortSignal.timeout(3000) });
          const ports = await portsRes.json() as Array<{ port: number; service?: string; project?: string }>;
          const mc = ports.find(p => p.service === 'polarclaw-web' || (p.project || '').toLowerCase().includes('polarclaw'));
          return mc?.port ?? 3910;
        } catch { return 3910; }
      })();

      const chatRes = await fetch(`http://127.0.0.1:${polarClawPort}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: systemPrompt,
          messages: [{ role: 'user', content: '请为以上任务分配生成可执行的 Agent Prompt。' }],
          context_query: `${row.title} ${row.goal}`,
        }),
        signal: AbortSignal.timeout(900_000), // 15 minutes
      });

      if (!chatRes.ok) {
        const errText = await chatRes.text();
        res.status(502).json({ error: `PolarClaw error: ${chatRes.status} ${errText}` });
        return;
      }

      const chatData = await chatRes.json() as { content: string; usage?: unknown; model?: string };
      let prompts: Array<{ task_index: number; task_title: string; agent_type: string; prompt: string }> = [];
      try {
        const jsonMatch = chatData.content.match(/\[[\s\S]*\]/);
        if (jsonMatch) prompts = JSON.parse(jsonMatch[0]);
      } catch {
        prompts = [{ task_index: 0, task_title: 'raw', agent_type: 'solo', prompt: chatData.content }];
      }

      res.json({ ok: true, prompts, model: chatData.model, usage: chatData.usage });
    } catch (err) {
      ctx.logger.error({ err }, 'prolusion generate-prompts error');
      res.status(500).json({ error: String(err) });
    }
  });
  startWatchdog(ctx);
}

// ── Service Health Checks ──────────────────────────────────────────

interface ServiceStatus {
  name: string;
  url: string;
  consoleUrl: string;
  status: 'up' | 'down' | 'unknown';
  latencyMs: number;
  detail?: string;
}

async function probeService(
  name: string,
  healthUrl: string,
  consoleUrl: string,
  timeoutMs = 3000,
): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(healthUrl, { signal: ctrl.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    if (r.ok) {
      let detail: string | undefined;
      try {
        const body = await r.json() as Record<string, unknown>;
        if (body.device && typeof body.device === 'object') {
          const d = body.device as Record<string, unknown>;
          detail = `${d.hostname ?? ''} | CPU ${(body.resource as Record<string, unknown>)?.cpu_percent ?? '?'}%`;
        } else if (body.vault_unlocked !== undefined) {
          // PolarPrivate /health 格式: { status, vault_unlocked }
          detail = `${body.status ?? 'ok'} | vault ${body.vault_unlocked ? 'unlocked' : 'locked'}`;
        } else if (body.status) {
          detail = String(body.status);
        }
      } catch { /* ignore parse errors */ }
      return { name, url: healthUrl, consoleUrl, status: 'up', latencyMs, detail };
    }
    return { name, url: healthUrl, consoleUrl, status: 'down', latencyMs: Date.now() - start, detail: `HTTP ${r.status}` };
  } catch (err) {
    return { name, url: healthUrl, consoleUrl, status: 'down', latencyMs: Date.now() - start, detail: String(err) };
  }
}

// 端口从 SOTAgent port-sdk 动态获取，环境变量作为回退
let SOTAGENT_API_PORT = process.env.SOTAGENT_API_PORT ?? '4800';
let SOTAGENT_CONSOLE_PORT = process.env.SOTAGENT_CONSOLE_PORT ?? '4880';
let PP_API_PORT = process.env.POLAR_PRIVATE_PORT ?? '12790';
let PP_CONSOLE_PORT = process.env.POLAR_PRIVATE_CONSOLE_PORT ?? '5170';

let _portsSynced = false;
async function syncPortsFromSOTAgent(): Promise<void> {
  if (_portsSynced) return;
  try {
    const resp = await fetch(`http://127.0.0.1:${SOTAGENT_API_PORT}/api/ports/config`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return;
    const config = await resp.json() as Record<string, number>;
    if (config.sotagent_api) SOTAGENT_API_PORT = String(config.sotagent_api);
    if (config.sotagent_console) SOTAGENT_CONSOLE_PORT = String(config.sotagent_console);
    if (config.polar_private) PP_API_PORT = String(config.polar_private);
    _portsSynced = true;
  } catch { /* SOTAgent not reachable, use defaults */ }
}

async function checkAllServices(_ctx: HubContext): Promise<ServiceStatus[]> {
  await syncPortsFromSOTAgent();
  const services = [
    { name: 'SOTAgent', healthUrl: `http://127.0.0.1:${SOTAGENT_API_PORT}/api/status`, consoleUrl: `http://localhost:${SOTAGENT_CONSOLE_PORT}` },
    { name: 'PolarPrivate', healthUrl: `http://127.0.0.1:${PP_API_PORT}/health`, consoleUrl: `http://localhost:${PP_CONSOLE_PORT}` },
    { name: 'PolarCopilot Hub', healthUrl: `http://127.0.0.1:${process.env.PC_HUB_PORT ?? 8040}/api/ui/prompts`, consoleUrl: '/pc/' },
  ];
  return Promise.all(services.map((s) => probeService(s.name, s.healthUrl, s.consoleUrl)));
}

// ── Watchdog ───────────────────────────────────────────────────────

let watchdogInterval: ReturnType<typeof setInterval> | null = null;
let watchdogRestartInProgress = false;

function startWatchdog(ctx: HubContext): void {
  if (watchdogInterval) return;
  const INTERVAL_MS = 30_000;
  const HEALTH_TIMEOUT_MS = 10_000;
  let consecutiveFailures = 0;

  watchdogInterval = setInterval(async () => {
    if (watchdogRestartInProgress) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
      const r = await fetch(`http://127.0.0.1:${SOTAGENT_API_PORT}/api/status`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        if (consecutiveFailures > 0) {
          ctx.logger.info({ after_failures: consecutiveFailures }, 'watchdog: SOTAgent recovered');
        }
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        ctx.logger.warn({ status: r.status, failures: consecutiveFailures }, 'watchdog: SOTAgent unhealthy');
      }
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures <= 3) {
        ctx.logger.warn({ err: String(err), failures: consecutiveFailures }, 'watchdog: SOTAgent unreachable');
      }
      if (consecutiveFailures === 3) {
        ctx.logger.warn('watchdog: SOTAgent down for 3+ checks, suppressing further warnings');
      }
    }
  }, INTERVAL_MS);
}

// ── Wave Computation ───────────────────────────────────────────────

interface TaskNode {
  id: string;
  depends_on: string[];
  status: string;
}

function computeWaves(taskList: TaskNode[]): string[][] {
  const taskMap = new Map(taskList.map((t) => [t.id, t]));
  const waves: string[][] = [];
  const assigned = new Set<string>();

  for (let wave = 0; wave < 100 && assigned.size < taskList.length; wave++) {
    const currentWave: string[] = [];
    for (const task of taskList) {
      if (assigned.has(task.id)) continue;
      const depsSatisfied = task.depends_on.every(
        (depId) => assigned.has(depId) || !taskMap.has(depId),
      );
      if (depsSatisfied) currentWave.push(task.id);
    }
    if (currentWave.length === 0) {
      for (const task of taskList) {
        if (!assigned.has(task.id)) currentWave.push(task.id);
      }
    }
    waves.push(currentWave);
    for (const id of currentWave) assigned.add(id);
  }
  return waves;
}

