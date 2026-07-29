import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    const queue = new CursorSpawnQueue(store, { gapMs: 1_000, pollMs: 100, waitOnlineTimeoutMs: 500 });
    const sessionA = store.register({ name: 'A' }).session;
    const sessionB = store.register({ name: 'B' }).session;

    const p1 = queue.enqueue({ session: sessionA, waitUntilOnline: false });
    const p2 = queue.enqueue({ session: sessionB, waitUntilOnline: false });

    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(order).toEqual([sessionA.sessionId, sessionB.sessionId]);
    vi.useRealTimers();
  });

  it('waits for online before next job in batch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-queue-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'), { offlineAfterMs: 90_000 });
    const order: string[] = [];

    const queue = new CursorSpawnQueue(store, { gapMs: 0, pollMs: 50, waitOnlineTimeoutMs: 5_000 });
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

    const queue = new CursorSpawnQueue(store, { gapMs: 5_000, pollMs: 50, waitOnlineTimeoutMs: 500 });
    const p1 = queue.enqueue({ session: sessionA, waitUntilOnline: false });
    const p2 = queue.enqueue({ session: sessionB, waitUntilOnline: false });

    await p1;
    store.removeSession(sessionB.sessionId);
    queue.cancelJobsForSession(sessionB.sessionId);

    await expect(p2).rejects.toThrow('session_deleted');
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0].session.sessionId).toBe(sessionA.sessionId);
  });
});
