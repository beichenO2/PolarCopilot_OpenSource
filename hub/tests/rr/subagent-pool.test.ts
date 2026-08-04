import { describe, expect, it } from 'vitest';
import { allowPoolGrowth, allowPoolShrinking, mergeManagedSubagentIds, planSubagentPool } from '../../src/rr/orchestrator/subagent-pool.js';
import type { RrSession } from '../../src/rr/types.js';

function session(id: string, overrides: Partial<RrSession> = {}): RrSession {
  const now = Date.now();
  return {
    sessionId: id,
    name: id,
    title: id,
    createdAt: now - 10_000,
    lastActiveAt: now - 10_000,
    agentStatus: 'ready',
    waiting: false,
    pendingMessages: 0,
    online: true,
    isSubagent: true,
    uiLocale: 'zh-cn',
    lastMessageTs: now - 10_000,
    status: 'online',
    ...overrides,
  };
}

describe('subagent pool planner', () => {
  const config = { desiredCount: 3, allowNewSubagents: true, recoveryCooldownMs: 60_000, pruneAfterMs: 15 * 60_000 };

  it('keeps runtime replacement ids alongside static seed ids', () => {
    expect(mergeManagedSubagentIds(['dead', 'sub-2'], ['sub-2', 'replacement'])).toEqual([
      'dead',
      'sub-2',
      'replacement',
    ]);
  });

  it('respawns an offline managed subagent before considering pruning', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [
        session('sub-1', { online: false, status: 'offline', lastActiveAt: now - 60_000 }),
        session('sub-2'),
        session('sub-3'),
      ],
      { managedIds: ['sub-1', 'sub-2', 'sub-3'], lastRecoveryAt: {} },
      config,
      now,
    );
    expect(result.actions).toEqual([{ kind: 'respawn', sessionId: 'sub-1', reason: 'offline' }]);
  });

  it('prunes a repeatedly stale offline subagent and schedules a replacement', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [
        session('sub-1', { online: false, status: 'offline', lastActiveAt: now - 20 * 60_000 }),
        session('sub-2'),
        session('sub-3'),
      ],
      { managedIds: ['sub-1', 'sub-2', 'sub-3'], lastRecoveryAt: { 'sub-1': now - 20 * 60_000 } },
      config,
      now,
    );
    expect(result.actions).toEqual([
      { kind: 'prune', sessionId: 'sub-1', reason: 'stale_offline' },
      { kind: 'create', reason: 'pool_below_target' },
    ]);
  });

  it('creates a replacement when a managed session disappeared', () => {
    const result = planSubagentPool(
      [session('sub-1'), session('sub-2')],
      { managedIds: ['sub-1', 'sub-2', 'deleted-subagent'], lastRecoveryAt: {} },
      config,
      Date.now(),
    );
    expect(result.actions).toEqual([{ kind: 'create', reason: 'pool_below_target' }]);
  });

  it('does not create replacements when new subagents are disabled, but still respawns offline sessions', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [
        session('sub-1', { online: false, status: 'offline', lastActiveAt: now - 10_000 }),
      ],
      { managedIds: ['sub-1', 'missing-subagent'], lastRecoveryAt: {} },
      { ...config, allowNewSubagents: false },
      now,
    );
    expect(result.actions).toEqual([{ kind: 'respawn', sessionId: 'sub-1', reason: 'offline' }]);
  });

  it('does not prune an existing stale session when new subagents are disabled', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [session('sub-1', { online: false, status: 'offline', lastActiveAt: now - 20 * 60_000 })],
      { managedIds: ['sub-1'], lastRecoveryAt: { 'sub-1': now - 20 * 60_000 } },
      { ...config, allowNewSubagents: false },
      now,
    );
    expect(result.actions).toEqual([{ kind: 'respawn', sessionId: 'sub-1', reason: 'offline' }]);
  });

  it('ignores a managed id that points to a master session', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [session('master', { isSubagent: false, online: false, status: 'offline', lastActiveAt: now - 20 * 60_000 })],
      { managedIds: ['master'], lastRecoveryAt: { master: now - 20 * 60_000 } },
      config,
      now,
    );
    expect(result.actions).toEqual([{ kind: 'create', reason: 'pool_below_target' }, { kind: 'create', reason: 'pool_below_target' }, { kind: 'create', reason: 'pool_below_target' }]);
  });

  it('does not prune when allowNewSubagents is omitted (strict shrink gate)', () => {
    const now = Date.now();
    const result = planSubagentPool(
      [session('sub-1', { online: false, status: 'offline', lastActiveAt: now - 20 * 60_000 })],
      { managedIds: ['sub-1'], lastRecoveryAt: { 'sub-1': now - 20 * 60_000 } },
      { desiredCount: 1, recoveryCooldownMs: 60_000, pruneAfterMs: 15 * 60_000 },
      now,
    );
    expect(result.actions).toEqual([{ kind: 'respawn', sessionId: 'sub-1', reason: 'offline' }]);
    expect(result.actions.some((action) => action.kind === 'prune')).toBe(false);
  });

  it('exposes allowNewSubagents gate helpers', () => {
    expect(allowPoolShrinking({ desiredCount: 1, recoveryCooldownMs: 1, pruneAfterMs: 1, allowNewSubagents: true })).toBe(true);
    expect(allowPoolShrinking({ desiredCount: 1, recoveryCooldownMs: 1, pruneAfterMs: 1, allowNewSubagents: false })).toBe(false);
    expect(allowPoolGrowth({ desiredCount: 1, recoveryCooldownMs: 1, pruneAfterMs: 1, allowNewSubagents: false })).toBe(false);
    expect(allowPoolGrowth({ desiredCount: 1, recoveryCooldownMs: 1, pruneAfterMs: 1 })).toBe(true);
  });
});
