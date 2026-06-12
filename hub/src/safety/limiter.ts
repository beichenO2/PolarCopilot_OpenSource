import { eq } from 'drizzle-orm';
import { agentSafetyLimits, type HubDb } from '../persistence/db.js';
import type { SafetyLimits } from '../types.js';

export type Usage = { calls: number; tokens: number; startMs: number };

export type AgentBudgetSnapshot = {
  agentId: string;
  usage: Usage;
  limits: SafetyLimits | undefined;
  /** Remaining token budget. Infinity when no limits configured. */
  remainingTokens: number;
};

export class SafetyLimiter {
  private readonly limits = new Map<string, SafetyLimits>();
  private readonly usage = new Map<string, Usage>();

  constructor(private readonly db: HubDb) {
    this.loadAll();
  }

  private loadAll(): void {
    const rows = this.db.select().from(agentSafetyLimits).all();
    for (const r of rows) {
      this.limits.set(r.agentId, {
        max_tool_calls: r.maxToolCalls,
        max_tokens: r.maxTokens,
        max_wall_time_ms: r.maxWallTimeMs,
      });
      this.usage.set(r.agentId, { calls: 0, tokens: 0, startMs: Date.now() });
    }
  }

  get(agentId: string): SafetyLimits | undefined {
    return this.limits.get(agentId);
  }

  getUsage(agentId: string): Usage {
    return this.usage.get(agentId) ?? { calls: 0, tokens: 0, startMs: Date.now() };
  }

  /**
   * Ensure an agent has a usage record even without explicit limits.
   * Called on hub_register so token tracking works for all agents.
   */
  ensureTracked(agentId: string): void {
    if (!this.usage.has(agentId)) {
      this.usage.set(agentId, { calls: 0, tokens: 0, startMs: Date.now() });
    }
  }

  /**
   * Return budget snapshots for all tracked agents, sorted by
   * remaining token budget descending (most remaining first).
   */
  allBudgets(): AgentBudgetSnapshot[] {
    const result: AgentBudgetSnapshot[] = [];
    for (const [agentId, usage] of this.usage) {
      const limits = this.limits.get(agentId);
      const remaining = limits ? limits.max_tokens - usage.tokens : Infinity;
      result.push({ agentId, usage, limits, remainingTokens: remaining });
    }
    result.sort((a, b) => b.remainingTokens - a.remainingTokens);
    return result;
  }

  /**
   * Rank agents by token efficiency — agents that used fewer tokens
   * get higher priority for the next task assignment.
   * Returns agent IDs ordered from least-used to most-used.
   */
  rankByTokenAvailability(candidateAgentIds?: string[]): string[] {
    const candidates = candidateAgentIds
      ? this.allBudgets().filter((b) => candidateAgentIds.includes(b.agentId))
      : this.allBudgets();

    return candidates
      .filter((b) => {
        if (!b.limits) return true;
        return b.usage.tokens < b.limits.max_tokens;
      })
      .sort((a, b) => a.usage.tokens - b.usage.tokens)
      .map((b) => b.agentId);
  }

  setPersisted(
    agentId: string,
    limits: SafetyLimits,
    expectedVersion?: number,
  ):
    | { status: 'success'; limits: SafetyLimits; version: number }
    | { status: 'conflict'; limits: SafetyLimits; version: number } {
    const now = new Date();
    const existing = this.db.select().from(agentSafetyLimits).where(eq(agentSafetyLimits.agentId, agentId)).get();
    if (existing && expectedVersion !== undefined && existing.version !== expectedVersion) {
      return {
        status: 'conflict',
        version: existing.version,
        limits: {
          max_tool_calls: existing.maxToolCalls,
          max_tokens: existing.maxTokens,
          max_wall_time_ms: existing.maxWallTimeMs,
        },
      };
    }
    const nextVersion = existing ? existing.version + 1 : 0;
    this.db
      .insert(agentSafetyLimits)
      .values({
        agentId,
        maxToolCalls: limits.max_tool_calls,
        maxTokens: limits.max_tokens,
        maxWallTimeMs: limits.max_wall_time_ms,
        version: nextVersion,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentSafetyLimits.agentId,
        set: {
          maxToolCalls: limits.max_tool_calls,
          maxTokens: limits.max_tokens,
          maxWallTimeMs: limits.max_wall_time_ms,
          version: nextVersion,
          updatedAt: now,
        },
      })
      .run();
    this.limits.set(agentId, limits);
    this.usage.set(agentId, { calls: 0, tokens: 0, startMs: Date.now() });
    return { status: 'success', limits, version: nextVersion };
  }

  check(agentId: string): { ok: true } | { ok: false; reason: string } {
    const L = this.limits.get(agentId);
    if (!L) return { ok: true };
    const u = this.usage.get(agentId) ?? { calls: 0, tokens: 0, startMs: Date.now() };
    if (u.calls >= L.max_tool_calls) return { ok: false, reason: 'max_tool_calls_exceeded' };
    if (u.tokens >= L.max_tokens) return { ok: false, reason: 'max_tokens_exceeded' };
    if (Date.now() - u.startMs >= L.max_wall_time_ms) return { ok: false, reason: 'max_wall_time_exceeded' };
    return { ok: true };
  }

  recordToolCall(agentId: string, estimatedTokens = 0): void {
    const u = this.usage.get(agentId) ?? { calls: 0, tokens: 0, startMs: Date.now() };
    u.calls += 1;
    u.tokens += estimatedTokens;
    this.usage.set(agentId, u);
  }
}
