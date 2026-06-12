import { and, eq, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { HubAcquireLeaseOutput } from '../protocol/leases.js';
import type { PathLease } from '../types.js';
import { pathLeases, type HubDb } from './db.js';

export class PathLeaseService {
  constructor(private readonly db: HubDb) {}

  private purgeExpired(now: Date = new Date()): void {
    this.db.delete(pathLeases).where(lte(pathLeases.expiresAt, now)).run();
  }

  private mapRow(row: typeof pathLeases.$inferSelect): PathLease {
    return {
      path: row.path,
      agent_id: row.agentId,
      lease_id: row.leaseId,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    };
  }

  check(path: string, now: Date = new Date()): PathLease | null {
    this.purgeExpired(now);
    const row = this.db.select().from(pathLeases).where(eq(pathLeases.path, path)).get();
    if (!row) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    return this.mapRow(row);
  }

  acquire(params: { agentId: string; path: string; ttlMs: number }): HubAcquireLeaseOutput {
    const now = new Date();
    this.purgeExpired(now);

    const existing = this.db.select().from(pathLeases).where(eq(pathLeases.path, params.path)).get();
    if (existing && existing.expiresAt.getTime() > now.getTime()) {
      if (existing.agentId === params.agentId) {
        const extended = new Date(now.getTime() + params.ttlMs);
        this.db
          .update(pathLeases)
          .set({ expiresAt: extended, createdAt: existing.createdAt })
          .where(eq(pathLeases.leaseId, existing.leaseId))
          .run();
        const refreshed = this.db.select().from(pathLeases).where(eq(pathLeases.leaseId, existing.leaseId)).get();
        if (!refreshed) {
          throw new Error('lease_missing_after_renew');
        }
        return { status: 'granted', lease: this.mapRow(refreshed) };
      }
      return { status: 'conflict', holder: this.mapRow(existing) };
    }

    if (existing) {
      this.db.delete(pathLeases).where(eq(pathLeases.path, params.path)).run();
    }

    const leaseId = nanoid();
    const expiresAt = new Date(now.getTime() + params.ttlMs);
    this.db
      .insert(pathLeases)
      .values({
        leaseId,
        path: params.path,
        agentId: params.agentId,
        createdAt: now,
        expiresAt,
      })
      .run();

    return {
      status: 'granted',
      lease: {
        path: params.path,
        agent_id: params.agentId,
        lease_id: leaseId,
        expires_at: expiresAt,
        created_at: now,
      },
    };
  }

  release(params: { agentId: string; leaseId?: string; path?: string }): boolean {
    const now = new Date();
    this.purgeExpired(now);

    if (params.leaseId) {
      const row = this.db.select().from(pathLeases).where(eq(pathLeases.leaseId, params.leaseId)).get();
      if (!row || row.agentId !== params.agentId) {
        return false;
      }
      this.db.delete(pathLeases).where(eq(pathLeases.leaseId, params.leaseId)).run();
      return true;
    }

    if (params.path) {
      const row = this.db.select().from(pathLeases).where(eq(pathLeases.path, params.path)).get();
      if (!row || row.agentId !== params.agentId) {
        return false;
      }
      this.db.delete(pathLeases).where(and(eq(pathLeases.path, params.path), eq(pathLeases.agentId, params.agentId))).run();
      return true;
    }

    return false;
  }
}
