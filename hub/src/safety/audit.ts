import { and, eq, gt } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { auditLog, type HubDb } from '../persistence/db.js';
import type { AuditEntry } from '../types.js';

export class AuditJournal {
  constructor(private readonly db: HubDb) {}

  append(entry: {
    agentId: string;
    taskId: string | null;
    action: string;
    details: unknown;
    correlationId: string | null;
  }): AuditEntry {
    const id = nanoid();
    const now = new Date();
    this.db
      .insert(auditLog)
      .values({
        id,
        agentId: entry.agentId,
        taskId: entry.taskId,
        action: entry.action,
        details: JSON.stringify(entry.details),
        createdAt: now,
        correlationId: entry.correlationId,
      })
      .run();
    return {
      id,
      agent_id: entry.agentId,
      task_id: entry.taskId,
      action: entry.action,
      details: entry.details,
      timestamp: now,
      correlation_id: entry.correlationId,
    };
  }

  list(params: {
    afterId?: string;
    limit: number;
    agentId?: string;
    taskId?: string;
  }): { entries: AuditEntry[]; cursor?: string } {
    const conditions = [];

    if (params.afterId) {
      const gate = this.db.select().from(auditLog).where(eq(auditLog.id, params.afterId)).get();
      if (gate) conditions.push(gt(auditLog.createdAt, gate.createdAt));
    }
    if (params.agentId) conditions.push(eq(auditLog.agentId, params.agentId));
    if (params.taskId) conditions.push(eq(auditLog.taskId, params.taskId));

    const query = this.db.select().from(auditLog);
    const rows = (conditions.length > 0
      ? query.where(and(...conditions))
      : query
    )
      .orderBy(auditLog.createdAt)
      .limit(params.limit)
      .all();

    const entries: AuditEntry[] = rows.map((r) => ({
      id: r.id,
      agent_id: r.agentId,
      task_id: r.taskId ?? null,
      action: r.action,
      details: JSON.parse(r.details) as unknown,
      timestamp: r.createdAt,
      correlation_id: r.correlationId ?? null,
    }));
    const cursor = rows.length > 0 ? rows[rows.length - 1]!.id : undefined;
    return { entries, cursor };
  }
}
