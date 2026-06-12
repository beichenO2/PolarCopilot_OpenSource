import { eq } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { clkState } from '../persistence/db.js';
import type { BroadcastPublisher } from '../broadcast/publisher.js';
import type { RoleManager } from './manager.js';

export interface ClkState {
  tickNumber: number;
  tickIntervalMs: number;
  lastTickAt: Date | null;
}

export interface TickReport {
  tick_number: number;
  timestamp: Date;
  stale_roles: string[];
  all_stale: boolean;
  reserve_count: number;
}

/**
 * CLK (Clock) service — periodic heartbeat and health monitor.
 * Persists tick state to SQLite and publishes tick events.
 */
export class ClkService {
  private db: HubDb;
  private publisher: BroadcastPublisher;
  private roleManager: RoleManager;
  private logger: { warn?: (msg: string) => void; info?: (msg: string) => void };
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: HubDb,
    publisher: BroadcastPublisher,
    roleManager: RoleManager,
    logger: { warn?: (msg: string) => void; info?: (msg: string) => void } = {},
  ) {
    this.db = db;
    this.publisher = publisher;
    this.roleManager = roleManager;
    this.logger = logger;
  }

  getState(): ClkState {
    const row = this.db
      .select()
      .from(clkState)
      .where(eq(clkState.id, 1))
      .get();

    if (!row) {
      return { tickNumber: 0, tickIntervalMs: 30000, lastTickAt: null };
    }

    return {
      tickNumber: row.tickNumber,
      tickIntervalMs: row.tickIntervalMs,
      lastTickAt: row.lastTickAt,
    };
  }

  tick(): TickReport {
    const state = this.getState();
    const newTickNumber = state.tickNumber + 1;
    const now = new Date();

    // Persist tick state
    this.db
      .update(clkState)
      .set({
        tickNumber: newTickNumber,
        lastTickAt: now,
      })
      .where(eq(clkState.id, 1))
      .run();

    // Find stale roles (using default 150s threshold)
    const staleRoles = this.roleManager.findStale(150_000);
    const staleRoleIds = staleRoles.map((r) => r.agentId);
    const allActive = this.roleManager.getAllActive();
    const allStale = allActive.length > 0 && staleRoles.length === allActive.length;

    // Publish tick event
    try {
      this.publisher.publish({
        sourceAgentId: 'clk',
        topic: 'system.tick',
        payload: {
          tick_number: newTickNumber,
          timestamp: now.toISOString(),
          stale_roles: staleRoleIds,
          all_stale: allStale,
        },
      });
    } catch {
      // Publisher may not be fully initialized in some test paths
    }

    const reserveCount = this.roleManager.reserveCount();

    return {
      tick_number: newTickNumber,
      timestamp: now,
      stale_roles: staleRoleIds,
      all_stale: allStale,
      reserve_count: reserveCount,
    };
  }

  setTickInterval(ms: number): void {
    this.db
      .update(clkState)
      .set({ tickIntervalMs: ms })
      .where(eq(clkState.id, 1))
      .run();
  }

  start(): void {
    this.stop();
    const state = this.getState();
    this.intervalId = setInterval(() => {
      this.tick();
    }, state.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
