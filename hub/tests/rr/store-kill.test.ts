import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as cursorSpawn from '../../src/rr/cursor-spawn.js';
import { RrFileStore } from '../../src/rr/store.js';

describe('RrFileStore cursor agent lifecycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('tracks pid and kills CLI on removeSession', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-store-kill-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'));
    const session = store.register({ name: 'Test Agent' }).session;
    const stopSpy = vi.spyOn(cursorSpawn, 'stopCursorAgentForSession').mockResolvedValue(undefined);

    store.setCursorAgentManaged(session.sessionId, {
      pid: 4242,
      polarProcessServiceId: 'rr-cursor-test',
    });
    store.removeSession(session.sessionId);

    expect(stopSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.sessionId,
      cursorAgentPid: 4242,
      polarProcessServiceId: 'rr-cursor-test',
    }));
  });

  it('blocks re-register after delete via sessionId and launchId tombstones', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-store-tombstone-'));
    roots.push(root);
    const store = new RrFileStore(join(root, 'chat'));
    const session = store.register({ name: 'Test Agent', launchId: 'rrlaunch-dead-1' }).session;

    store.removeSession(session.sessionId);

    expect(() => store.register({ sessionId: session.sessionId, name: 'Test Agent', launchId: 'rrlaunch-dead-1' }))
      .toThrow('session_deleted');
    expect(() => store.register({ name: 'Test Agent', launchId: 'rrlaunch-dead-1' }))
      .toThrow('session_deleted');
    expect(store.isSessionDeleted(session.sessionId)).toBe(true);
    expect(store.isLaunchIdDeleted('rrlaunch-dead-1')).toBe(true);
  });
});
