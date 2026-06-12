import { eq } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { agentRoles, reservePool } from '../persistence/db.js';

export interface RoleAssignment {
  agentId: string;
  role: string;
  status: 'active' | 'dead' | 'assigned';
  tmuxSession: string | null;
  assignedAt: Date;
  lastHeartbeat: Date | null;
  stateSnapshot: Record<string, unknown> | null;
  predecessorId: string | null;
}

/**
 * Manages agent roles backed by SQLite (agent_roles + reserve_pool tables).
 */
export class RoleManager {
  private db: HubDb;

  constructor(db: HubDb) {
    this.db = db;
  }

  assignRole(agentId: string, role: string, tmuxSession: string): RoleAssignment {
    const now = new Date();

    // If this agent is in the reserve pool, mark it as assigned
    this.db.delete(reservePool).where(eq(reservePool.agentId, agentId)).run();

    this.db
      .insert(agentRoles)
      .values({
        agentId,
        role,
        status: 'active',
        tmuxSession,
        assignedAt: now,
        lastHeartbeat: now,
        stateSnapshot: null,
        predecessorId: null,
      })
      .onConflictDoUpdate({
        target: [agentRoles.agentId],
        set: {
          role,
          status: 'active',
          tmuxSession,
          assignedAt: now,
          lastHeartbeat: now,
        },
      })
      .run();

    return this.getRole(agentId)!;
  }

  getRole(agentId: string): RoleAssignment | null {
    const row = this.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.agentId, agentId))
      .get();

    if (!row) return null;

    return {
      agentId: row.agentId,
      role: row.role,
      status: row.status as RoleAssignment['status'],
      tmuxSession: row.tmuxSession,
      assignedAt: row.assignedAt,
      lastHeartbeat: row.lastHeartbeat,
      stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : null,
      predecessorId: row.predecessorId,
    };
  }

  getRoleByType(role: string): RoleAssignment | null {
    const row = this.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.role, role))
      .get();

    if (!row) return null;

    return {
      agentId: row.agentId,
      role: row.role,
      status: row.status as RoleAssignment['status'],
      tmuxSession: row.tmuxSession,
      assignedAt: row.assignedAt,
      lastHeartbeat: row.lastHeartbeat,
      stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : null,
      predecessorId: row.predecessorId,
    };
  }

  getAllActive(): RoleAssignment[] {
    const rows = this.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.status, 'active'))
      .all();

    return rows.map((row) => ({
      agentId: row.agentId,
      role: row.role,
      status: 'active' as const,
      tmuxSession: row.tmuxSession,
      assignedAt: row.assignedAt,
      lastHeartbeat: row.lastHeartbeat,
      stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : null,
      predecessorId: row.predecessorId,
    }));
  }

  markDead(agentId: string): void {
    this.db
      .update(agentRoles)
      .set({ status: 'dead' })
      .where(eq(agentRoles.agentId, agentId))
      .run();
  }

  recordHeartbeat(agentId: string): void {
    this.db
      .update(agentRoles)
      .set({ lastHeartbeat: new Date() })
      .where(eq(agentRoles.agentId, agentId))
      .run();
  }

  saveStateSnapshot(agentId: string, snapshot: Record<string, unknown>): void {
    this.db
      .update(agentRoles)
      .set({ stateSnapshot: JSON.stringify(snapshot) })
      .where(eq(agentRoles.agentId, agentId))
      .run();
  }

  findStale(maxAgeMs: number): RoleAssignment[] {
    const cutoff = new Date(Date.now() - maxAgeMs);

    const rows = this.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.status, 'active'))
      .all()
      .filter((r) => {
        if (!r.lastHeartbeat) return true;
        return r.lastHeartbeat < cutoff;
      });

    return rows.map((row) => ({
      agentId: row.agentId,
      role: row.role,
      status: 'active' as const,
      tmuxSession: row.tmuxSession,
      assignedAt: row.assignedAt,
      lastHeartbeat: row.lastHeartbeat,
      stateSnapshot: row.stateSnapshot ? JSON.parse(row.stateSnapshot) : null,
      predecessorId: row.predecessorId,
    }));
  }

  addToReserve(agentId: string, tmuxSession: string): void {
    const now = new Date();
    this.db
      .insert(reservePool)
      .values({
        agentId,
        tmuxSession,
        status: 'standby',
        createdAt: now,
        assignedAt: null,
      })
      .onConflictDoUpdate({
        target: [reservePool.agentId],
        set: { status: 'standby', tmuxSession },
      })
      .run();
  }

  reserveCount(): number {
    const result = this.db
      .select({ count: reservePool.agentId })
      .from(reservePool)
      .where(eq(reservePool.status, 'standby'))
      .all();
    return result.length;
  }

  takeFromReserve(): RoleAssignment | null {
    const row = this.db
      .select()
      .from(reservePool)
      .where(eq(reservePool.status, 'standby'))
      .limit(1)
      .get();

    if (!row) return null;

    const now = new Date();

    // Remove from reserve
    this.db.delete(reservePool).where(eq(reservePool.agentId, row.agentId)).run();

    // Assign as active
    this.db
      .insert(agentRoles)
      .values({
        agentId: row.agentId,
        role: 'worker',
        status: 'assigned',
        tmuxSession: row.tmuxSession,
        assignedAt: now,
        lastHeartbeat: now,
        stateSnapshot: null,
        predecessorId: null,
      })
      .onConflictDoUpdate({
        target: [agentRoles.agentId],
        set: { status: 'assigned', assignedAt: now, lastHeartbeat: now },
      })
      .run();

    return this.getRole(row.agentId)!;
  }

  succeedRole(deadAgentId: string): RoleAssignment | null {
    const reserveRow = this.db
      .select()
      .from(reservePool)
      .where(eq(reservePool.status, 'standby'))
      .limit(1)
      .get();

    if (!reserveRow) return null;

    // Mark the dead agent as dead (if not already)
    this.db
      .update(agentRoles)
      .set({ status: 'dead' })
      .where(eq(agentRoles.agentId, deadAgentId))
      .run();

    // Remove from reserve
    this.db.delete(reservePool).where(eq(reservePool.agentId, reserveRow.agentId)).run();

    // Get the role of the dead agent
    const deadRole = this.db
      .select()
      .from(agentRoles)
      .where(eq(agentRoles.agentId, deadAgentId))
      .get();

    const roleToAssign = deadRole ? deadRole.role : 'worker';

    // Assign the reserve agent to the same role
    const now = new Date();
    this.db
      .insert(agentRoles)
      .values({
        agentId: reserveRow.agentId,
        role: roleToAssign,
        status: 'active',
        tmuxSession: reserveRow.tmuxSession,
        assignedAt: now,
        lastHeartbeat: now,
        stateSnapshot: null,
        predecessorId: deadAgentId,
      })
      .onConflictDoUpdate({
        target: [agentRoles.agentId],
        set: {
          role: roleToAssign,
          status: 'active',
          predecessorId: deadAgentId,
          assignedAt: now,
          lastHeartbeat: now,
        },
      })
      .run();

    return this.getRole(reserveRow.agentId)!;
  }
}
