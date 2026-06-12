import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { desc, eq } from 'drizzle-orm';
import { Validator, type Schema } from '@cfworker/json-schema';
import type pino from 'pino';
import { listActiveAlerts, pushAlert } from '../alerts/router.js';
import type { SseHub } from '../broadcast/sse-hub.js';
import type { BroadcastPublisher } from '../broadcast/publisher.js';
import { sessions, events, type HubDb } from '../persistence/db.js';

/** Must match Agent_core/contracts/checkup-agent.id */
export const CHECKUP_AGENT_ID = '@checkup-agent';
export const CHECKUP_INBOX_TOPIC = `${CHECKUP_AGENT_ID}.inbox`;

export type CheckupEventStatus = 'pending' | 'processing' | 'resolved' | 'needs_human';

export interface CheckupReportEntry {
  status?: string;
  summary?: string;
  handler?: string;
}

/**
 * Status precedence when merging multiple report alerts for the same event.
 *
 *   needs_human > resolved > processing > pending
 *
 * Terminal states (needs_human / resolved) win over interim markers
 * (processing emitted by `hub-checkup-watcher`, pending fallback), so a
 * PolarUI `resolved` report posted after the Hub enqueue marker collapses to
 * `resolved`. Within terminal states `needs_human` still trumps `resolved`
 * because human approval should not be auto-dismissed.
 */
const CHECKUP_REPORT_STATUS_RANK: Record<CheckupEventStatus, number> = {
  needs_human: 4,
  resolved: 3,
  processing: 2,
  pending: 1,
};

function extractEventIdFromContext(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const record = context as Record<string, unknown>;
  if (record.event_id != null) return String(record.event_id);
  const event = record.event;
  if (event && typeof event === 'object' && (event as Record<string, unknown>).event_id != null) {
    return String((event as Record<string, unknown>).event_id);
  }
  return undefined;
}

export function parseReportAlert(detail: string): ({ event_id?: string } & CheckupReportEntry) | null {
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    if (parsed.type === 'checkup_human_approval') {
      const eventId = parsed.event_id != null
        ? String(parsed.event_id)
        : extractEventIdFromContext(parsed.context);
      return {
        event_id: eventId,
        status: 'needs_human',
        summary: String(parsed.reason ?? '需人工介入'),
        handler: '@checkup-agent',
      };
    }
    if (!parsed.event_id) return null;
    return {
      event_id: String(parsed.event_id),
      status: parsed.status != null ? String(parsed.status) : undefined,
      summary: parsed.summary != null ? String(parsed.summary) : undefined,
      handler: parsed.handler != null ? String(parsed.handler) : undefined,
    };
  } catch {
    return null;
  }
}

export function mergeCheckupReportStatus(
  fixStatus?: string,
  humanStatus?: string,
  opts?: { approved?: boolean; shellOk?: boolean },
): CheckupEventStatus {
  if (opts?.shellOk === false) return 'needs_human';
  const statuses = new Set<CheckupEventStatus>();
  if (fixStatus) statuses.add(normalizeStatus(fixStatus));
  if (humanStatus) statuses.add(normalizeStatus(humanStatus));
  if (opts?.approved === false) statuses.add('needs_human');
  if (opts?.shellOk === true) statuses.add('resolved');
  if (statuses.size === 0) return 'pending';
  let best: CheckupEventStatus = 'pending';
  for (const status of statuses) {
    if (CHECKUP_REPORT_STATUS_RANK[status] > CHECKUP_REPORT_STATUS_RANK[best]) best = status;
  }
  return best;
}

/**
 * Reports emitted by the Hub-side enqueue daemon. Their summary is just a
 * "queued" marker — when a richer report from PolarUI arrives, the richer
 * summary always wins regardless of status rank.
 */
const ENQUEUE_HANDLER = 'hub-checkup-watcher';

function isEnqueueMarker(entry: CheckupReportEntry | undefined): boolean {
  return entry?.handler === ENQUEUE_HANDLER;
}

export function mergeReportEntry(
  existing: CheckupReportEntry | undefined,
  incoming: CheckupReportEntry,
): CheckupReportEntry {
  if (!existing) return { ...incoming };
  const status = mergeCheckupReportStatus(existing.status, incoming.status);
  // Enqueue markers never overwrite richer reports; richer reports always
  // overwrite enqueue markers' summary/handler.
  if (isEnqueueMarker(incoming) && !isEnqueueMarker(existing)) {
    return { status, summary: existing.summary, handler: existing.handler };
  }
  if (isEnqueueMarker(existing) && !isEnqueueMarker(incoming)) {
    return {
      status,
      summary: incoming.summary ?? existing.summary,
      handler: incoming.handler ?? existing.handler,
    };
  }
  // Both rich (or both enqueue): retain previous behaviour — incoming wins,
  // existing fills in missing fields.
  return {
    status,
    summary: incoming.summary ?? existing.summary,
    handler: incoming.handler ?? existing.handler,
  };
}

export function indexReportsFromAlerts(
  alerts: Array<{ source: string; title: string; detail: string }>,
): Map<string, CheckupReportEntry> {
  const reportByEventId = new Map<string, CheckupReportEntry>();
  for (const alert of alerts) {
    if (
      alert.source !== 'polarui-output-display'
      && alert.title !== '检修处理结果'
      && alert.title !== '检修：需人工介入'
    ) {
      continue;
    }
    const report = parseReportAlert(alert.detail);
    if (!report?.event_id) continue;
    reportByEventId.set(report.event_id, mergeReportEntry(reportByEventId.get(report.event_id), report));
  }
  return reportByEventId;
}

function normalizeStatus(raw?: string): CheckupEventStatus {
  if (!raw) return 'pending';
  const s = raw.toLowerCase();
  if (s === 'needs_human' || s === 'failed') return 'needs_human';
  if (s === 'resolved' || s === 'triaged' || s === 'done') return 'resolved';
  if (s === 'processing' || s === 'running') return 'processing';
  return 'pending';
}

export interface CheckupHistoryRow {
  event_id: string;
  project: string;
  page_url: string;
  user_text: string;
  timestamp: string;
  received_at?: string;
  status: CheckupEventStatus;
  summary?: string;
  handler?: string;
}

const checkupSseClients = new Set<Response>();

export function buildCheckupHistory(
  envelopes: Array<{ received_at?: string; event: Record<string, unknown> }>,
  reportByEventId: Map<string, CheckupReportEntry>,
  inboxEventIds: Set<string>,
  processingEventIds: Set<string>,
): CheckupHistoryRow[] {
  const rows: CheckupHistoryRow[] = [];
  for (const envelope of envelopes) {
    const event = envelope.event;
    const eventId = String(event.event_id ?? '');
    if (!eventId) continue;
    const report = reportByEventId.get(eventId);
    let status = normalizeStatus(report?.status);
    if (!report) {
      if (processingEventIds.has(eventId)) status = 'processing';
      else if (inboxEventIds.has(eventId)) status = 'pending';
    }
    rows.push({
      event_id: eventId,
      project: String(event.project ?? ''),
      page_url: String(event.page_url ?? ''),
      user_text: String(event.user_text ?? ''),
      timestamp: String(event.timestamp ?? ''),
      received_at: envelope.received_at,
      status,
      summary: report?.summary,
      handler: report?.handler,
    });
  }
  rows.sort((a, b) => {
    const ta = Date.parse(a.received_at ?? a.timestamp) || 0;
    const tb = Date.parse(b.received_at ?? b.timestamp) || 0;
    return tb - ta;
  });
  return rows;
}

function checkupJsonlCandidatePaths(): string[] {
  return [
    ...(process.env.PC_CHECKUP_JSONL_PATH ? [process.env.PC_CHECKUP_JSONL_PATH] : []),
    join(process.env.HOME ?? '', 'Polarisor', 'SOTAgent', 'data', 'checkup-events.jsonl'),
    join(process.env.HOME ?? '', 'Polarisor', 'PolarOps', 'data', 'checkup-events.jsonl'),
  ];
}

export function loadCheckupEnvelopesFromJsonl(limit: number): Array<{ received_at?: string; event: Record<string, unknown> }> {
  for (const filePath of checkupJsonlCandidatePaths()) {
    if (!existsSync(filePath)) continue;
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n').filter((l) => l.trim());
      return lines.slice(-limit).map((line) => JSON.parse(line) as { received_at?: string; event: Record<string, unknown> });
    } catch {
      continue;
    }
  }
  return [];
}

export function loadCheckupEnvelopesFromHubDb(db: HubDb, limit: number): Array<{ received_at?: string; event: Record<string, unknown> }> {
  try {
    const rows = db
      .select()
      .from(events)
      .where(eq(events.topic, CHECKUP_INBOX_TOPIC))
      .orderBy(desc(events.sequenceNumber))
      .all();
    const slice = rows.slice(-limit);
    const out: Array<{ received_at?: string; event: Record<string, unknown> }> = [];
    for (const row of slice) {
      try {
        const payload = JSON.parse(row.payload) as { event?: Record<string, unknown> };
        if (payload.event) {
          out.push({
            received_at: row.createdAt ?? undefined,
            event: payload.event,
          });
        }
      } catch { /* skip */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export async function fetchCheckupEnvelopes(
  deps: { db: HubDb; sotagentBase: string; forwardEnabled: boolean; logger: pino.Logger },
  limit: number,
): Promise<Array<{ received_at?: string; event: Record<string, unknown> }>> {
  const merged = new Map<string, { received_at?: string; event: Record<string, unknown> }>();

  const add = (rows: Array<{ received_at?: string; event: Record<string, unknown> }>) => {
    for (const row of rows) {
      const id = String(row.event?.event_id ?? '');
      if (id) merged.set(id, row);
    }
  };

  if (deps.forwardEnabled) {
    try {
      const r = await fetch(`${deps.sotagentBase}/api/checkup-events?limit=${limit}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        add((await r.json()) as Array<{ received_at?: string; event: Record<string, unknown> }>);
      }
    } catch (err) {
      deps.logger.warn({ err }, 'checkup-events list: SOTAgent fetch failed');
    }
  }

  add(loadCheckupEnvelopesFromJsonl(limit));
  add(loadCheckupEnvelopesFromHubDb(deps.db, limit));

  return [...merged.values()]
    .sort((a, b) => {
      const ta = Date.parse(a.received_at ?? String(a.event.timestamp ?? '')) || 0;
      const tb = Date.parse(b.received_at ?? String(b.event.timestamp ?? '')) || 0;
      return tb - ta;
    })
    .slice(0, limit);
}

function notifyCheckupSse(event: Record<string, unknown>): void {
  const chunk = `event: checkup_event\ndata: ${JSON.stringify({ event })}\n\n`;
  for (const res of checkupSseClients) {
    try {
      res.write(chunk);
    } catch {
      checkupSseClients.delete(res);
    }
  }
}

export interface CheckupRouterDeps {
  db: HubDb;
  publisher: BroadcastPublisher;
  logger: pino.Logger;
  /** Override SOTAgent forwarding URL. Default uses port 4800. */
  sotagentBase?: string;
  /** Disable SOTAgent forwarding entirely (used by tests). */
  disableSotagentForward?: boolean;
  /** Optional SSE hub for `alert_new` broadcast when daemon enqueues an event. */
  sseHub?: SseHub;
  /** Disable Hub-side enqueue daemon (used by tests). Default off. */
  disableEnqueueDaemon?: boolean;
}

const DEFAULT_SCHEMA_PATH = process.env.PC_CHECKUP_SCHEMA_PATH
  ?? join(process.env.HOME ?? '', 'Polarisor', 'Agent_core', 'contracts', 'checkup-event.schema.json');

let cachedValidator: Validator | undefined;

function getValidator(): Validator {
  if (cachedValidator) return cachedValidator;
  const raw = readFileSync(DEFAULT_SCHEMA_PATH, 'utf-8');
  const schema = JSON.parse(raw) as Schema;
  cachedValidator = new Validator(schema, '7', false);
  return cachedValidator;
}

export function createCheckupRouter(deps: CheckupRouterDeps): Router {
  const router = Router();
  const { db, publisher, logger, sseHub } = deps;
  const sotagentBase = deps.sotagentBase ?? 'http://127.0.0.1:4800';
  const forwardEnabled = !deps.disableSotagentForward;
  const enqueueDaemonEnabled = !deps.disableEnqueueDaemon;

  router.get('/ui/checkup-events', async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const envelopes = await fetchCheckupEnvelopes(
      { db, sotagentBase, forwardEnabled, logger },
      limit,
    );

    const reportByEventId = indexReportsFromAlerts(listActiveAlerts());

    const inboxEventIds = new Set<string>();
    const processingEventIds = new Set<string>();
    const now = Date.now();
    for (const envelope of envelopes) {
      const id = String(envelope.event?.event_id ?? '');
      if (!id) continue;
      inboxEventIds.add(id);
      const receivedAt = Date.parse(envelope.received_at ?? String(envelope.event.timestamp ?? ''));
      const report = reportByEventId.get(id);
      if (!report && Number.isFinite(receivedAt) && now - receivedAt < 60_000) {
        processingEventIds.add(id);
      }
    }

    const rows = buildCheckupHistory(envelopes, reportByEventId, inboxEventIds, processingEventIds);
    res.json({
      ok: true,
      count: rows.length,
      stats: {
        pending: rows.filter((r) => r.status === 'pending').length,
        processing: rows.filter((r) => r.status === 'processing').length,
        resolved: rows.filter((r) => r.status === 'resolved').length,
        needs_human: rows.filter((r) => r.status === 'needs_human').length,
      },
      events: rows,
    });
  });

  router.get('/ui/checkup-events/:eventId/status', async (req: Request, res: Response) => {
    const eventId = req.params.eventId;
    if (!eventId) {
      res.status(400).json({ ok: false, error: 'event_id_required' });
      return;
    }
    let envelope: { received_at?: string; event: Record<string, unknown> } | undefined;
    const all = await fetchCheckupEnvelopes({ db, sotagentBase, forwardEnabled, logger }, 200);
    envelope = all.find((e) => String(e.event?.event_id ?? '') === eventId);
    if (!envelope) {
      res.status(404).json({ ok: false, error: 'event_not_found', event_id: eventId });
      return;
    }
    const reportByEventId = indexReportsFromAlerts(listActiveAlerts());
    const [row] = buildCheckupHistory([envelope], reportByEventId, new Set([eventId]), new Set());
    res.json({ ok: true, event: row });
  });

  router.get('/ui/checkup/stream', (req: Request, res: Response) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    res.write(': connected\n\n');
    checkupSseClients.add(res);
    req.on('close', () => {
      checkupSseClients.delete(res);
    });
  });

  router.post('/checkup-event', async (req: Request, res: Response) => {
    let validator: Validator;
    try {
      validator = getValidator();
    } catch (err) {
      logger.error({ err, schemaPath: DEFAULT_SCHEMA_PATH }, 'checkup-event: schema load failed');
      res.status(500).json({ ok: false, error: 'schema_unavailable' });
      return;
    }

    const result = validator.validate(req.body);
    if (!result.valid) {
      const errors = result.errors.map((e) => ({
        path: e.instanceLocation,
        keyword: e.keyword,
        message: e.error,
      }));
      res.status(400).json({ ok: false, error: 'invalid_payload', errors });
      return;
    }

    const event = req.body as {
      event_id: string;
      project: string;
      agent_target: string;
      page_url: string;
      page_title?: string;
      user_text: string;
      timestamp: string;
    };

    const targetRow = event.agent_target === CHECKUP_AGENT_ID
      ? { agentId: CHECKUP_AGENT_ID }
      : db
          .select()
          .from(sessions)
          .where(eq(sessions.agentId, event.agent_target))
          .get();

    if (!targetRow) {
      res.status(404).json({
        ok: false,
        error: 'agent_target_not_found',
        agent_target: event.agent_target,
      });
      return;
    }

    let routedToInbox = false;
    try {
      publisher.publish({
        sourceAgentId: 'hub-checkup',
        topic: `${CHECKUP_AGENT_ID}.inbox`,
        payload: { type: 'checkup_event', event },
        idempotencyKey: `checkup:${event.event_id}`,
      });
      routedToInbox = true;
      notifyCheckupSse(event as unknown as Record<string, unknown>);
    } catch (err) {
      logger.error({ err, eventId: event.event_id }, 'checkup-event: inbox publish failed');
    }

    // Hub-side enqueue daemon: publish a `processing` report alert immediately
    // so the user can see "已入队 @checkup-agent" within 60s even when PolarUI
    // browser/Electron is not running. The PolarUI checkup-runner — when online
    // — emits a richer `resolved` / `needs_human` report later via the same
    // alert channel, which `indexReportsFromAlerts` collapses by event_id and
    // status rank, so this enqueue marker never downgrades the final verdict.
    if (routedToInbox && enqueueDaemonEnabled) {
      try {
        pushAlert(
          {
            source: 'hub-checkup-watcher',
            severity: 'info',
            title: '检修处理结果',
            detail: JSON.stringify({
              event_id: event.event_id,
              status: 'processing',
              summary: `已入队 @checkup-agent；PolarUI 在线后会接管诊断/修复`,
              handler: 'hub-checkup-watcher',
            }),
            timestamp: new Date().toISOString(),
          },
          sseHub,
        );
      } catch (err) {
        logger.warn({ err, eventId: event.event_id }, 'checkup-event: enqueue alert push failed (non-fatal)');
      }
    }

    let forwardedToSotagent = false;
    let forwardError: string | undefined;
    if (forwardEnabled) {
      try {
        const r = await fetch(`${sotagentBase}/api/checkup-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(3000),
        });
        forwardedToSotagent = r.ok;
        if (!r.ok) forwardError = `http_${r.status}`;
      } catch (err) {
        forwardError = err instanceof Error ? err.message : String(err);
        logger.warn({ err, eventId: event.event_id }, 'checkup-event: SOTAgent forward failed (non-fatal)');
      }
    }

    res.status(200).json({
      ok: true,
      event_id: event.event_id,
      routed_to_inbox: routedToInbox,
      forwarded_to_sotagent: forwardedToSotagent,
      forward_error: forwardError,
    });
  });

  return router;
}
