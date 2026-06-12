import { and, eq, lte } from 'drizzle-orm';
import { tasks, type HubDb } from '../persistence/db.js';

export function releaseExpiredTaskLeases(db: HubDb, now: Date = new Date()): number {
  const res = db
    .update(tasks)
    .set({
      status: 'open',
      ownerAgentId: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(tasks.status, 'claimed'), lte(tasks.leaseExpiresAt, now)))
    .run();
  return res.changes ?? 0;
}
