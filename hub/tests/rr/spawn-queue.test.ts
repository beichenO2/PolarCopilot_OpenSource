import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as budgetGate from '../../src/rr/afk/budget-gate.js';
import * as cursorSpawn from '../../src/rr/cursor-spawn.js';
import { RrFileStore } from '../../src/rr/store.js';
import { CursorSpawnQueue } from '../../src/rr/spawn-queue.js';

describe('CursorSpawnQueue', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('runs spawn jobs sequentially with gap', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const order: string[] = [];
    const sessionA = store.register({ name: 'A' }).session;
    const sessionB = store.register({ name: 'B' }).session;

    vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockImplementation(async ({ session }) => {
      order.push(session.sessionId);
      return {
        ok: true,
        sessionId: session.sessionId,
        workspace: root,
        pid: order.length,
        polarProcessServiceId: `rr-cursor-${session.sessionId}`,
        mode: 'headless',
        cursorBin: 'cursor',
      };
    });
    vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);

    const queue = new CursorSpawnQueue(store, {
      gapMs: 1_000,
      pollMs: 100,
      waitOnlineTimeoutMs: 500,
      budgetGate: false,
    });

    const p1 = queue.enqueue({ session: sessionA, waitUntilOnline: false });
    const p2 = queue.enqueue({ session: sessionB, waitUntilOnline: false });

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual([sessionA.sessionId, sessionB.sessionId]);
    vi.useRealTimers();
  });

  it('uses batchGapMs=0 for fleet batch jobs while keeping solo gapMs', async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-batch-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const timestamps: number[] = [];
    const sessionA = store.register({ name: 'A' }).session;
    const sessionB = store.register({ name: 'B' }).session;

    vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockImplementation(async ({ session }) => {
      timestamps.push(Date.now());
      return {
        ok: true,
        sessionId: session.sessionId,
        workspace: root,
        pid: timestamps.length,
        polarProcessServiceId: `rr-cursor-${session.sessionId}`,
        mode: 'headless',
        cursorBin: 'cursor',
      };
    });
    vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);

    const queue = new CursorSpawnQueue(store, {
      gapMs: 5_000,
      batchGapMs: 0,
      pollMs: 100,
      waitOnlineTimeoutMs: 500,
      budgetGate: false,
    });
    const batch = queue.createBatch();
    const p1 = queue.enqueue({ session: sessionA, waitUntilOnline: false }, batch.batchId);
    const p2 = queue.enqueue({ session: sessionB, waitUntilOnline: false }, batch.batchId);

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]! - timestamps[0]!).toBeLessThan(5_000);
    vi.useRealTimers();
  });

  it('waits for online before next job in batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const order: string[] = [];

    const queue = new CursorSpawnQueue(store, {
      gapMs: 0,
      pollMs: 50,
      waitOnlineTimeoutMs: 5_000,
      budgetGate: false,
    });
    const main = store.register({ name: '主', launchId: 'launch-main' }).session;
    const sub = store.register({ name: '子1', launchId: 'launch-sub' }).session;

    vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockImplementation(async ({ session }) => {
      order.push(`spawn:${session.sessionId}`);
      if (session.sessionId === main.sessionId) {
        const current = store.getSession(main.sessionId);
        writeFileSync(
          join(store.root, 'sessions', `${main.sessionId}.json`),
          `${JSON.stringify({ ...current, waiting: true, status: 'waiting' }, null, 2)}\n`,
        );
      }
      return {
        ok: true,
        sessionId: session.sessionId,
        workspace: root,
        pid: order.length,
        polarProcessServiceId: `rr-cursor-${session.sessionId}`,
        mode: 'headless',
        cursorBin: 'cursor',
      };
    });
    vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);

    const processBatch = queue.createBatch();
    await Promise.all([
      queue.enqueue({ session: main, waitUntilOnline: true, label: '主' }, processBatch.batchId),
      queue.enqueue({ session: sub, waitUntilOnline: true, label: '子1' }, processBatch.batchId),
    ]);

    expect(order).toEqual([`spawn:${main.sessionId}`, `spawn:${sub.sessionId}`]);
    expect(queue.getBatch(processBatch.batchId)?.status).toBe('completed');
  });

  it('cancels pending jobs when session is deleted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-cancel-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const sessionA = store.register({ name: 'A' }).session;
    const sessionB = store.register({ name: 'B' }).session;

    const spawnSpy = vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockImplementation(async ({ session }) => ({
      ok: true as const,
      sessionId: session.sessionId,
      workspace: root,
      pid: session.sessionId === sessionA.sessionId ? 11 : 22,
      polarProcessServiceId: `rr-cursor-${session.sessionId}`,
      mode: 'headless' as const,
      cursorBin: 'cursor',
    }));
    vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);

    const queue = new CursorSpawnQueue(store, {
      gapMs: 5_000,
      pollMs: 50,
      waitOnlineTimeoutMs: 500,
      budgetGate: false,
    });
    const p1 = queue.enqueue({ session: sessionA, waitUntilOnline: false });
    const p2 = queue.enqueue({ session: sessionB, waitUntilOnline: false });

    await p1;
    store.removeSession(sessionB.sessionId);
    queue.cancelJobsForSession(sessionB.sessionId);

    await expect(p2).rejects.toThrow('session_deleted');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0].session.sessionId).toBe(sessionA.sessionId);
  });

  it('defers spawn when PolarBudget gate denies after wait exhausted (C4)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-budget-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const session = store.register({ name: 'BudgetDenied' }).session;
    const spawnSpy = vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockResolvedValue({
      ok: true,
      sessionId: session.sessionId,
      workspace: root,
      pid: 99,
      polarProcessServiceId: `rr-cursor-${session.sessionId}`,
      mode: 'headless',
      cursorBin: 'cursor',
    });
    vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: false,
      reason: 'lease_wait_timeout',
      recommended_jobs: 1,
      budget: { ok: false, reason: 'budget_unavailable', recommended_jobs: 1 },
    });

    const queue = new CursorSpawnQueue(store, { gapMs: 0, budgetGate: true, budgetWaitMs: 0 });
    await expect(queue.enqueue({ session, waitUntilOnline: false }))
      .rejects.toThrow('budget_spawn_deferred:lease_wait_timeout');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('spawns after PolarBudget 候补 gate allows', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-budget-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const session = store.register({ name: 'BudgetWait' }).session;
    const spawnSpy = vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockResolvedValue({
      ok: true,
      sessionId: session.sessionId,
      workspace: root,
      pid: 99,
      polarProcessServiceId: `rr-cursor-${session.sessionId}`,
      mode: 'headless',
      cursorBin: 'cursor',
    });
    const gateSpy = vi.spyOn(budgetGate, 'canSpawnAgent').mockResolvedValue({
      allowed: true,
      reason: 'lease_acquired_or_wait',
      recommended_jobs: 1,
      budget: { ok: true, recommended_jobs: 1, reason: 'warm' },
      leaseId: 'lease-wait-1',
    });

    const queue = new CursorSpawnQueue(store, { gapMs: 0, budgetGate: true });
    await queue.enqueue({ session, waitUntilOnline: false });
    expect(gateSpy).toHaveBeenCalledOnce();
    expect(gateSpy.mock.calls[0]?.[0]).toMatchObject({
      estimatedJobs: 1,
      acquireLease: true,
      owner: expect.stringMatching(/^rr-spawn-queue:/),
    });
    expect(spawnSpy).toHaveBeenCalledOnce();
  });

  it('drains fleet batch spawns when PolarBudget is unavailable (fail-open admission floor)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-fleet-offline-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const sessions = Array.from({ length: 10 }, (_, i) => store.register({ name: `Fleet ${i}` }).session);
    const spawnSpy = vi.spyOn(cursorSpawn, 'spawnCursorAgent').mockImplementation(async ({ session }) => ({
      ok: true as const,
      sessionId: session.sessionId,
      workspace: root,
      pid: Number.parseInt(session.sessionId.slice(0, 4), 16) % 10_000,
      polarProcessServiceId: `rr-cursor-${session.sessionId}`,
      mode: 'headless' as const,
      cursorBin: 'cursor',
    }));
    vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);
    const gateSpy = vi.spyOn(budgetGate, 'canSpawnAgent');

    const queue = new CursorSpawnQueue(store, {
      gapMs: 0,
      batchGapMs: 0,
      budgetGate: true,
      budgetWaitMs: 0,
    });
    const batch = queue.createBatch();
    await Promise.all(
      sessions.map((session) => queue.enqueue({ session, waitUntilOnline: false }, batch.batchId)),
    );

    expect(gateSpy).toHaveBeenCalledTimes(10);
    expect(gateSpy.mock.calls.every(([arg]) => arg.owner?.startsWith('rr-spawn-queue:'))).toBe(true);
    expect(gateSpy.mock.results.every((r) => r.type === 'return' && r.value instanceof Promise)).toBe(true);
    const gateOutcomes = await Promise.all(
      gateSpy.mock.results.map((r) => r.value as ReturnType<typeof budgetGate.canSpawnAgent>),
    );
    expect(gateOutcomes.every((g) => g.allowed && g.reason === 'budget_unavailable_admission_floor')).toBe(true);
    expect(spawnSpy).toHaveBeenCalledTimes(10);
    expect(queue.getStatus().pendingCount).toBe(0);
    expect(queue.getBatch(batch.batchId)?.status).toBe('completed');
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('/api/lease'))).toBe(true);
    vi.unstubAllGlobals();
  });
});
