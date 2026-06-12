import { and, eq } from 'drizzle-orm';
import { moduleAffinity, type HubDb } from '../persistence/db.js';
import type { SafetyLimiter } from '../safety/limiter.js';

export type AffinityMatch = {
  agent_id: string;
  source: 'declared' | 'earned';
  completed_count: number;
  tokens_used: number;
};

/**
 * Module-owner affinity tracker.
 * Agents build affinity with modules by completing tasks tagged with that module.
 * Scheduling prefers the agent with strongest affinity for a module.
 */
export class ModuleAffinityService {
  constructor(
    private readonly db: HubDb,
    private readonly limiter: SafetyLimiter | null,
  ) {}

  declareOwnership(agentId: string, modules: string[]): void {
    const now = new Date();
    for (const mod of modules) {
      this.db
        .insert(moduleAffinity)
        .values({
          agentId,
          module: mod,
          source: 'declared',
          completedCount: 0,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [moduleAffinity.agentId, moduleAffinity.module],
          set: { source: 'declared', updatedAt: now },
        })
        .run();
    }
  }

  /**
   * Record that an agent completed a task in a given module.
   * Creates implicit "earned" affinity if not already declared.
   */
  recordCompletion(agentId: string, module: string): void {
    const now = new Date();
    const existing = this.db
      .select()
      .from(moduleAffinity)
      .where(and(eq(moduleAffinity.agentId, agentId), eq(moduleAffinity.module, module)))
      .get();

    if (existing) {
      this.db
        .update(moduleAffinity)
        .set({
          completedCount: existing.completedCount + 1,
          updatedAt: now,
        })
        .where(and(eq(moduleAffinity.agentId, agentId), eq(moduleAffinity.module, module)))
        .run();
    } else {
      this.db
        .insert(moduleAffinity)
        .values({
          agentId,
          module,
          source: 'earned',
          completedCount: 1,
          updatedAt: now,
        })
        .run();
    }
  }

  /**
   * Find the best agent for a given module.
   * Priority: declared > earned (by completed_count DESC).
   * Among equals, prefer the agent with fewer tokens consumed (lighter workload).
   */
  findBestAgent(module: string): AffinityMatch | null {
    const rows = this.db
      .select()
      .from(moduleAffinity)
      .where(eq(moduleAffinity.module, module))
      .all();

    if (rows.length === 0) return null;

    const scored = rows.map((r) => {
      const tokensUsed = this.limiter?.getUsage(r.agentId).tokens ?? 0;
      return {
        agent_id: r.agentId,
        source: r.source as 'declared' | 'earned',
        completed_count: r.completedCount,
        tokens_used: tokensUsed,
      };
    });

    scored.sort((a, b) => {
      // Declared ownership always wins over earned
      if (a.source === 'declared' && b.source !== 'declared') return -1;
      if (b.source === 'declared' && a.source !== 'declared') return 1;
      // More completions = stronger affinity
      if (b.completed_count !== a.completed_count) return b.completed_count - a.completed_count;
      // Tie-break: lighter token load preferred
      return a.tokens_used - b.tokens_used;
    });

    return scored[0] ?? null;
  }

  /**
   * Get all module affinities for an agent.
   */
  getAgentModules(agentId: string): { module: string; source: string; completed_count: number }[] {
    return this.db
      .select({
        module: moduleAffinity.module,
        source: moduleAffinity.source,
        completed_count: moduleAffinity.completedCount,
      })
      .from(moduleAffinity)
      .where(eq(moduleAffinity.agentId, agentId))
      .all();
  }

  /**
   * Get all agents with affinity for a given module, ranked.
   */
  getModuleOwners(module: string): AffinityMatch[] {
    const rows = this.db
      .select()
      .from(moduleAffinity)
      .where(eq(moduleAffinity.module, module))
      .all();

    return rows
      .map((r) => ({
        agent_id: r.agentId,
        source: r.source as 'declared' | 'earned',
        completed_count: r.completedCount,
        tokens_used: this.limiter?.getUsage(r.agentId).tokens ?? 0,
      }))
      .sort((a, b) => {
        if (a.source === 'declared' && b.source !== 'declared') return -1;
        if (b.source === 'declared' && a.source !== 'declared') return 1;
        if (b.completed_count !== a.completed_count) return b.completed_count - a.completed_count;
        return a.tokens_used - b.tokens_used;
      });
  }
}
