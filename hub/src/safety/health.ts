import { eq, isNull, sql } from 'drizzle-orm';
import { messages, sessions, tasks, type HubDb } from '../persistence/db.js';
import type { HealthStatus } from '../types.js';
import { ALIVE_THRESHOLD_MS } from '../constants.js';

export function buildHealthStatus(db: HubDb, staleMs: number = ALIVE_THRESHOLD_MS): HealthStatus {
  const now = Date.now();
  const staleBefore = new Date(now - staleMs);
  const sess = db.select().from(sessions).all();
  const stale_agents = sess
    .filter((s) => !s.lastPingAt || s.lastPingAt.getTime() < staleBefore.getTime())
    .map((s) => s.agentId);

  const qRow = db
    .select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(messages)
    .where(isNull(messages.consumedAt))
    .get();
  const queue_depth = qRow?.c ?? 0;

  const aRow = db
    .select({ c: sql<number>`count(*)`.mapWith(Number) })
    .from(tasks)
    .where(eq(tasks.status, 'claimed'))
    .get();
  const active_tasks = aRow?.c ?? 0;

  const anomalies: string[] = [];
  if (queue_depth > 10_000) anomalies.push('large_message_backlog');

  return { stale_agents, queue_depth, active_tasks, anomalies };
}
