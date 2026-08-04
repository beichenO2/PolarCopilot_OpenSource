import type { RrSession } from '../types.js';

export interface SubagentPoolConfig {
  desiredCount: number;
  allowNewSubagents?: boolean;
  recoveryCooldownMs: number;
  pruneAfterMs: number;
}

export interface SubagentPoolState {
  managedIds: string[];
  lastRecoveryAt: Record<string, number>;
}

export type SubagentPoolAction =
  | { kind: 'respawn'; sessionId: string; reason: 'offline' }
  | { kind: 'prune'; sessionId: string; reason: 'stale_offline' }
  | { kind: 'create'; reason: 'pool_below_target' };

export interface SubagentPoolPlan {
  actions: SubagentPoolAction[];
  managedIds: string[];
}

export function mergeManagedSubagentIds(configIds: string[] = [], stateIds: string[] = []): string[] {
  return [...new Set([...configIds, ...stateIds])];
}

/** Shrinking actions (prune / kill) require an explicit allowNewSubagents=true toggle. */
export function allowPoolShrinking(config: SubagentPoolConfig): boolean {
  return config.allowNewSubagents === true;
}

/** Creating new pool members is blocked only when allowNewSubagents === false. */
export function allowPoolGrowth(config: SubagentPoolConfig): boolean {
  return config.allowNewSubagents !== false;
}

/**
 * Decide how to keep the explicitly managed subagent roster healthy.
 * Unlisted Rr sessions are intentionally ignored so another project cannot
 * be pruned by this task's AFK loop.
 */
export function planSubagentPool(
  sessions: RrSession[],
  state: SubagentPoolState,
  config: SubagentPoolConfig,
  now = Date.now(),
): SubagentPoolPlan {
  const byId = new Map(sessions.map((session) => [session.sessionId, session]));
  const actions: SubagentPoolAction[] = [];
  const managedIds: string[] = [];

  for (const sessionId of state.managedIds) {
    const session = byId.get(sessionId);
    if (!session) continue;
    if (!session.isSubagent) continue;

    const offline = !session.online || session.status === 'offline';
    if (offline) {
      const lastRecoveryAt = state.lastRecoveryAt[sessionId] ?? 0;
      const stale = !session.activeTask
        && now - session.lastActiveAt >= config.pruneAfterMs
        && lastRecoveryAt > 0
        && now - lastRecoveryAt >= config.pruneAfterMs;
      if (stale && allowPoolShrinking(config)) {
        actions.push({ kind: 'prune', sessionId, reason: 'stale_offline' });
        continue;
      }

      if (lastRecoveryAt === 0 || now - lastRecoveryAt >= config.recoveryCooldownMs) {
        actions.push({ kind: 'respawn', sessionId, reason: 'offline' });
      }
    }
    managedIds.push(sessionId);
  }

  const desiredCount = Math.max(0, Math.floor(config.desiredCount));
  const createCount = allowPoolGrowth(config)
    ? Math.max(0, desiredCount - managedIds.length)
    : 0;
  for (let index = 0; index < createCount; index += 1) {
    actions.push({ kind: 'create', reason: 'pool_below_target' });
  }

  return { actions, managedIds };
}
