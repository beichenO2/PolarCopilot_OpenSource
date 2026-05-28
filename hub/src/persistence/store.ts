import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { AtomicWriteResult, MessageRow, PlanningDocument } from '../types.js';
import {
  agentCapabilities,
  agentRoles,
  auditLog,
  eventCursors,
  events,
  idempotencyKeys,
  messages,
  moduleAffinity,
  pathLeases,
  planningDocuments,
  reservePool,
  sessions,
  uiPrompts,
  agentSafetyLimits,
  type HubDb,
} from './db.js';

export class HubStore {
  constructor(private readonly db: HubDb) {}

  /**
   * Bind MCP transport session to an agent. Agent IDs are timestamp-based so
   * collisions are impossible — just upsert directly.
   */
  upsertSession(params: {
    mcpSessionId: string;
    agentId: string;
    label?: string | null;
    displayName?: string | null;
  }): { ok: true } | { ok: false; reason: string } {
    const now = new Date();

    const byAgent = this.db.select().from(sessions).where(eq(sessions.agentId, params.agentId)).get();
    if (byAgent) {
      this.db
        .update(sessions)
        .set({
          mcpSessionId: params.mcpSessionId,
          label: params.label ?? byAgent.label,
          displayName: params.displayName ?? byAgent.displayName,
          updatedAt: now,
          lastPingAt: now,
        })
        .where(eq(sessions.agentId, params.agentId))
        .run();
    } else {
      this.db
        .insert(sessions)
        .values({
          mcpSessionId: params.mcpSessionId,
          agentId: params.agentId,
          label: params.label ?? null,
          displayName: params.displayName ?? null,
          createdAt: now,
          updatedAt: now,
          lastPingAt: now,
        })
        .run();
    }

    return { ok: true };
  }

  /**
   * One-step HTTP registration: create session + first prompt + display_name.
   * Used by solo-web agents that don't have an MCP session.
   */
  registerAndPrompt(params: {
    agentId: string;
    displayName: string;
    prompt: string;
    options: string[];
  }): { ok: true; prompt_id: string } | { ok: false; reason: string } {
    const now = new Date();
    const ALIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours — must match constants.ts

    // ── Guard: reject if agent_id is already alive (another instance is active) ──
    const existing = this.db.select().from(sessions).where(eq(sessions.agentId, params.agentId)).get();
    if (existing?.lastPingAt) {
      const elapsed = now.getTime() - new Date(existing.lastPingAt).getTime();
      if (elapsed < ALIVE_THRESHOLD_MS) {
        return { ok: false, reason: `agent_id_in_use:${params.agentId}` };
      }
    }

    this.db
      .insert(sessions)
      .values({
        mcpSessionId: `http:${params.agentId}`,
        agentId: params.agentId,
        displayName: params.displayName,
        label: 'solo-web',
        createdAt: now,
        updatedAt: now,
        lastPingAt: now,
      })
      .onConflictDoUpdate({
        target: sessions.agentId,
        set: {
          displayName: params.displayName,
          updatedAt: now,
          lastPingAt: now,
        },
      })
      .run();

    const promptId = crypto.randomUUID();
    this.db
      .insert(uiPrompts)
      .values({
        id: promptId,
        prompt: params.prompt,
        optionsJson: JSON.stringify(params.options),
        answer: null,
        agentId: params.agentId,
        createdAt: now,
        answeredAt: null,
      })
      .run();

    return { ok: true, prompt_id: promptId };
  }

  getSessionByMcpId(mcpSessionId: string):
    | {
        mcpSessionId: string;
        agentId: string;
        label: string | null;
      }
    | undefined {
    const row = this.db.select().from(sessions).where(eq(sessions.mcpSessionId, mcpSessionId)).get();
    if (!row) return undefined;
    return { mcpSessionId: row.mcpSessionId, agentId: row.agentId, label: row.label };
  }

  recordPing(mcpSessionId: string): { ok: false } | { ok: true; agentId: string } {
    const row = this.db
      .select({ agentId: sessions.agentId })
      .from(sessions)
      .where(eq(sessions.mcpSessionId, mcpSessionId))
      .get();
    if (!row) return { ok: false };
    const now = new Date();
    this.db
      .update(sessions)
      .set({ lastPingAt: now, updatedAt: now })
      .where(eq(sessions.mcpSessionId, mcpSessionId))
      .run();
    return { ok: true, agentId: row.agentId };
  }

  countSessions(): number {
    const r = this.db.select({ c: sql<number>`count(*)`.mapWith(Number) }).from(sessions).get();
    return r?.c ?? 0;
  }

  /** 清理 lastPingAt 超过 ttlMs 的过期 session（回收站机制）。 */
  purgeExpiredSessions(ttlMs: number = 72 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - ttlMs);
    const result = this.db
      .delete(sessions)
      .where(lte(sessions.lastPingAt, cutoff))
      .run();
    return result.changes;
  }

  /** Used by tests and future producers; durable queue per agent. */
  enqueueMessage(agentId: string, payload: unknown): string {
    const id = nanoid();
    this.db
      .insert(messages)
      .values({
        id,
        agentId,
        payload: JSON.stringify(payload),
        createdAt: new Date(),
        consumedAt: null,
      })
      .run();
    return id;
  }

  listPendingMessages(agentId: string): MessageRow[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.agentId, agentId), isNull(messages.consumedAt)))
      .orderBy(messages.createdAt)
      .all();
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      payload: JSON.parse(r.payload) as unknown,
      createdAt: r.createdAt,
      consumedAt: r.consumedAt ?? null,
    }));
  }

  consumeMessages(agentId: string, ids: string[]): number {
    if (ids.length === 0) return 0;
    const now = new Date();
    let touched = 0;
    for (const id of ids) {
      const res = this.db
        .update(messages)
        .set({ consumedAt: now })
        .where(and(eq(messages.id, id), eq(messages.agentId, agentId), isNull(messages.consumedAt)))
        .run();
      touched += res.changes;
    }
    return touched;
  }

  /** Append a durable broadcast event; returns monotonic sequence number. */
  appendBroadcastEvent(params: {
    sourceAgentId: string;
    topic: string;
    payload: unknown;
  }): { id: string; sequenceNumber: number; createdAt: Date } {
    const id = nanoid();
    const createdAt = new Date();
    const inserted = this.db
      .insert(events)
      .values({
        id,
        sourceAgentId: params.sourceAgentId,
        topic: params.topic,
        payload: JSON.stringify(params.payload),
        createdAt,
      })
      .returning({
        sequenceNumber: events.sequenceNumber,
        id: events.id,
        createdAt: events.createdAt,
      })
      .get();
    if (!inserted) {
      throw new Error('failed to insert broadcast event');
    }
    return { id: inserted.id, sequenceNumber: inserted.sequenceNumber, createdAt: inserted.createdAt };
  }

  getBroadcastEventSequenceById(eventId: string): number | undefined {
    const row = this.db
      .select({ sequenceNumber: events.sequenceNumber })
      .from(events)
      .where(eq(events.id, eventId))
      .get();
    return row?.sequenceNumber;
  }

  listBroadcastEventsAfterSequence(
    exclusiveSeq: number,
    limit: number,
  ): { id: string; sourceAgentId: string; topic: string; payload: unknown; createdAt: Date; sequenceNumber: number }[] {
    const rows = this.db
      .select()
      .from(events)
      .where(gt(events.sequenceNumber, exclusiveSeq))
      .orderBy(events.sequenceNumber)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.id,
      sourceAgentId: r.sourceAgentId,
      topic: r.topic,
      payload: JSON.parse(r.payload) as unknown,
      createdAt: r.createdAt,
      sequenceNumber: r.sequenceNumber,
    }));
  }

  listEventsForAgent(
    exclusiveSeq: number,
    agentInbox: string,
    limit: number,
  ): { id: string; sourceAgentId: string; topic: string; payload: unknown; createdAt: Date; sequenceNumber: number }[] {
    const rows = this.db
      .select()
      .from(events)
      .where(
        and(
          gt(events.sequenceNumber, exclusiveSeq),
          or(eq(events.topic, 'broadcast'), eq(events.topic, agentInbox)),
        ),
      )
      .orderBy(events.sequenceNumber)
      .limit(limit)
      .all();
    return rows.map((r) => ({
      id: r.id,
      sourceAgentId: r.sourceAgentId,
      topic: r.topic,
      payload: JSON.parse(r.payload) as unknown,
      createdAt: r.createdAt,
      sequenceNumber: r.sequenceNumber,
    }));
  }

  getEventCursor(agentId: string): number {
    const row = this.db.select().from(eventCursors).where(eq(eventCursors.agentId, agentId)).get();
    return row?.lastSeenSequence ?? 0;
  }

  getMaxEventSequence(): number {
    const row = this.db
      .select({ max: sql<number>`MAX(${events.sequenceNumber})` })
      .from(events)
      .get();
    return row?.max ?? 0;
  }

  initEventCursorIfMissing(agentId: string): void {
    const maxSeq = this.getMaxEventSequence();
    this.db.insert(eventCursors)
      .values({ agentId, lastSeenSequence: maxSeq })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Delete events that all agents have already consumed.
   * Safe minimum = lowest cursor across all agents (or 0 if none).
   * Also deletes events older than maxAgeDays regardless of cursors.
   */
  pruneOldEvents(maxAgeDays = 7): { deletedByCursor: number; deletedByAge: number } {
    const minCursorRow = this.db
      .select({ min: sql<number>`MIN(${eventCursors.lastSeenSequence})` })
      .from(eventCursors)
      .get();
    const safeSeq = minCursorRow?.min ?? 0;

    let deletedByCursor = 0;
    if (safeSeq > 0) {
      const result = this.db.delete(events).where(lte(events.sequenceNumber, safeSeq)).run();
      deletedByCursor = result.changes;
    }

    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);
    const result2 = this.db.delete(events).where(lte(events.createdAt, cutoff)).run();
    const deletedByAge = result2.changes;

    return { deletedByCursor, deletedByAge };
  }

  /** Advance cursor to at least `lastSeenSequence` (monotonic). */
  upsertEventCursor(agentId: string, lastSeenSequence: number): void {
    const existing = this.db.select().from(eventCursors).where(eq(eventCursors.agentId, agentId)).get();
    if (!existing) {
      this.db.insert(eventCursors).values({ agentId, lastSeenSequence }).run();
      return;
    }
    if (lastSeenSequence <= existing.lastSeenSequence) return;
    this.db
      .update(eventCursors)
      .set({ lastSeenSequence })
      .where(eq(eventCursors.agentId, agentId))
      .run();
  }

  getPlanningDocument(path: string): PlanningDocument | null {
    const row = this.db.select().from(planningDocuments).where(eq(planningDocuments.path, path)).get();
    if (!row) return null;
    return {
      path: row.path,
      content: row.content,
      version: row.version,
      updated_by: row.updatedBy,
      updated_at: row.updatedAt,
    };
  }

  writePlanningDocument(params: {
    path: string;
    content: string;
    expectedVersion: number;
    updatedBy: string;
    /** When set, successful writes mirror to this filesystem root (atomic rename). */
    mirrorRoot?: string;
  }): AtomicWriteResult {
    const now = new Date();
    const row = this.db.select().from(planningDocuments).where(eq(planningDocuments.path, params.path)).get();

    if (!row) {
      if (params.expectedVersion !== 0) {
        return { status: 'conflict', version: 0 };
      }
      this.db
        .insert(planningDocuments)
        .values({
          path: params.path,
          content: params.content,
          version: 1,
          updatedBy: params.updatedBy,
          updatedAt: now,
        })
        .run();
      if (params.mirrorRoot) this.mirrorPlanningFile(params.mirrorRoot, params.path, params.content);
      return { status: 'success', version: 1 };
    }

    if (row.version !== params.expectedVersion) {
      return { status: 'conflict', version: row.version };
    }

    const nextVersion = row.version + 1;
    const upd = this.db
      .update(planningDocuments)
      .set({
        content: params.content,
        version: nextVersion,
        updatedBy: params.updatedBy,
        updatedAt: now,
      })
      .where(and(eq(planningDocuments.path, params.path), eq(planningDocuments.version, row.version)))
      .run();

    if (upd.changes === 0) {
      const latest = this.db.select().from(planningDocuments).where(eq(planningDocuments.path, params.path)).get();
      return { status: 'conflict', version: latest?.version ?? row.version };
    }

    if (params.mirrorRoot) this.mirrorPlanningFile(params.mirrorRoot, params.path, params.content);
    return { status: 'success', version: nextVersion };
  }

  private mirrorPlanningFile(root: string, relPath: string, content: string): void {
    const abs = HubStore.safeResolveUnderRoot(root, relPath);
    if (!abs) return;
    const dir = dirname(abs);
    mkdirSync(dir, { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, content, 'utf8');
      renameSync(tmp, abs);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore missing tmp */
      }
    }
  }

  static safeResolveUnderRoot(root: string, relPath: string): string | null {
    const rootAbs = resolve(root);
    const fileAbs = resolve(root, relPath);
    const prefix = rootAbs.endsWith(sep) ? rootAbs : rootAbs + sep;
    if (fileAbs !== rootAbs && !fileAbs.startsWith(prefix)) return null;
    return fileAbs;
  }

  getIdempotencyResult(key: string): unknown | null {
    this.purgeExpiredIdempotencyKeys();
    const row = this.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)).get();
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;
    return JSON.parse(row.result) as unknown;
  }

  setIdempotencyResult(key: string, result: unknown, ttlMs: number): void {
    const now = Date.now();
    this.db
      .insert(idempotencyKeys)
      .values({
        key,
        result: JSON.stringify(result),
        createdAt: new Date(now),
        expiresAt: new Date(now + ttlMs),
      })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: {
          result: sql`excluded.result`,
          createdAt: sql`excluded.created_at`,
          expiresAt: sql`excluded.expires_at`,
        },
      })
      .run();
  }

  private purgeExpiredIdempotencyKeys(): void {
    this.db.delete(idempotencyKeys).where(lte(idempotencyKeys.expiresAt, new Date())).run();
  }

  upsertAgentCapabilities(agentId: string, roles: string[], skills: string[]): void {
    const now = new Date();
    const row = {
      agentId,
      rolesJson: JSON.stringify(roles),
      skillsJson: JSON.stringify(skills),
      updatedAt: now,
    };
    this.db
      .insert(agentCapabilities)
      .values(row)
      .onConflictDoUpdate({
        target: agentCapabilities.agentId,
        set: {
          rolesJson: row.rolesJson,
          skillsJson: row.skillsJson,
          updatedAt: now,
        },
      })
      .run();
  }

  getAgentCapabilities(agentId: string): { roles: string[]; skills: string[] } | undefined {
    const r = this.db.select().from(agentCapabilities).where(eq(agentCapabilities.agentId, agentId)).get();
    if (!r) return undefined;
    return { roles: JSON.parse(r.rolesJson) as string[], skills: JSON.parse(r.skillsJson) as string[] };
  }

  listAgentIdsWithSkill(skill: string): string[] {
    const rows = this.db.select().from(agentCapabilities).all();
    const matches: string[] = [];
    for (const r of rows) {
      const skills = JSON.parse(r.skillsJson) as string[];
      if (skills.includes(skill)) matches.push(r.agentId);
    }
    return matches;
  }

  // ─── Sliding Window GC (24h) ─────────────────────────────────────

  /**
   * Unified garbage collection: delete records older than `maxAgeMs` across
   * all ephemeral tables. Designed to run periodically (e.g. every 15 min).
   *
   * Tables cleaned:
   *  - sessions (by last_ping_at)        → also cascades to agent_roles, capabilities, etc.
   *  - ui_prompts (by created_at)        → answered prompts only; pending kept regardless of age
   *  - events (by created_at)            → also cleans orphaned event_cursors
   *  - messages (by created_at)          → consumed messages only
   *  - audit_log (by created_at)
   *  - idempotency_keys (by expires_at)
   *  - path_leases (by expires_at)
   *
   * Returns per-table deletion counts for logging.
   */
  slidingWindowGC(maxAgeMs: number): Record<string, number> {
    const cutoff = new Date(Date.now() - maxAgeMs);
    const stats: Record<string, number> = {};

    // 1. Sessions: delete sessions whose last_ping_at is older than window
    const deadSessions = this.db
      .select({ agentId: sessions.agentId })
      .from(sessions)
      .where(
        or(
          lte(sessions.lastPingAt, cutoff),
          isNull(sessions.lastPingAt),
        ),
      )
      .all();
    const deadAgentIds = deadSessions.map((s) => s.agentId);

    if (deadAgentIds.length > 0) {
      let orphanCursorCount = 0;
      for (const aid of deadAgentIds) {
        // Auto-close pending prompts from dead agents so they don't become zombie cards
        const closedResult = this.db
          .update(uiPrompts)
          .set({ answer: '[auto-closed: agent offline]', answeredAt: new Date() })
          .where(and(eq(uiPrompts.agentId, aid), isNull(uiPrompts.answeredAt)))
          .run();
        orphanCursorCount += closedResult.changes;

        this.db.delete(sessions).where(eq(sessions.agentId, aid)).run();
        this.db.delete(agentRoles).where(eq(agentRoles.agentId, aid)).run();
        this.db.delete(agentCapabilities).where(eq(agentCapabilities.agentId, aid)).run();
        this.db.delete(agentSafetyLimits).where(eq(agentSafetyLimits.agentId, aid)).run();
        this.db.delete(moduleAffinity).where(eq(moduleAffinity.agentId, aid)).run();
        this.db.delete(reservePool).where(eq(reservePool.agentId, aid)).run();
        this.db.delete(eventCursors).where(eq(eventCursors.agentId, aid)).run();
      }
      stats.sessions = deadAgentIds.length;
      if (orphanCursorCount > 0) stats.orphan_cursors = orphanCursorCount;
    }

    // 2. UI Prompts: delete answered prompts older than window (keep pending ones)
    const promptResult = this.db
      .delete(uiPrompts)
      .where(
        and(
          lte(uiPrompts.createdAt, cutoff),
          sql`${uiPrompts.answeredAt} IS NOT NULL`,
        ),
      )
      .run();
    if (promptResult.changes > 0) stats.ui_prompts = promptResult.changes;

    // 3. Events: delete events older than window
    const eventResult = this.db
      .delete(events)
      .where(lte(events.createdAt, cutoff))
      .run();
    if (eventResult.changes > 0) stats.events = eventResult.changes;

    // 4. Messages: delete consumed messages older than window
    const msgResult = this.db
      .delete(messages)
      .where(
        and(
          lte(messages.createdAt, cutoff),
          sql`${messages.consumedAt} IS NOT NULL`,
        ),
      )
      .run();
    if (msgResult.changes > 0) stats.messages = msgResult.changes;

    // 5. Audit log: older than window
    const auditResult = this.db
      .delete(auditLog)
      .where(lte(auditLog.createdAt, cutoff))
      .run();
    if (auditResult.changes > 0) stats.audit_log = auditResult.changes;

    // 6. Idempotency keys: expired
    const idempResult = this.db
      .delete(idempotencyKeys)
      .where(lte(idempotencyKeys.expiresAt, new Date()))
      .run();
    if (idempResult.changes > 0) stats.idempotency_keys = idempResult.changes;

    // 7. Path leases: expired
    const leaseResult = this.db
      .delete(pathLeases)
      .where(lte(pathLeases.expiresAt, new Date()))
      .run();
    if (leaseResult.changes > 0) stats.path_leases = leaseResult.changes;

    // 8. Orphaned event cursors: agents that no longer exist in sessions
    const allCursors = this.db.select({ agentId: eventCursors.agentId }).from(eventCursors).all();
    const liveAgentIds = new Set(
      this.db.select({ agentId: sessions.agentId }).from(sessions).all().map((s) => s.agentId),
    );
    let orphanCursors = 0;
    for (const c of allCursors) {
      if (!liveAgentIds.has(c.agentId)) {
        this.db.delete(eventCursors).where(eq(eventCursors.agentId, c.agentId)).run();
        orphanCursors++;
      }
    }
    if (orphanCursors > 0) stats.orphan_cursors = orphanCursors;

    return stats;
  }
}
