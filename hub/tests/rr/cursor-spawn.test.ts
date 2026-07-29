import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRrLaunchPrompt } from '../../src/rr/launch-prompt.js';
import { defaultRrWorkspace, killCursorAgent, spawnCursorAgent } from '../../src/rr/cursor-spawn.js';
import * as polarProcess from '../../src/rr/polar-process-client.js';
import type { RrSession } from '../../src/rr/types.js';

describe('buildRrLaunchPrompt', () => {
  it('includes session identity fields', () => {
    const prompt = buildRrLaunchPrompt({
      sessionId: 'rr-mcp-agent-test',
      name: 'AFK 主会话',
      launchId: 'rrlaunch-123',
    });
    expect(prompt).toContain('rr-mcp-agent-test');
    expect(prompt).toContain('AFK 主会话');
    expect(prompt).toContain('rrlaunch-123');
    expect(prompt).toContain('register_session');
    expect(prompt).toContain('sessionId: "rr-mcp-agent-test"');
    expect(prompt).not.toContain('如需重连');
  });
});

describe('spawnCursorAgent', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('spawns cursor agent via PolarProcess with workspace and prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-spawn-'));
    roots.push(root);
    const fakeCursor = join(root, 'cursor');
    writeFileSync(fakeCursor, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(fakeCursor, 0o755);

    const session: RrSession = {
      sessionId: 'rr-mcp-agent-test',
      name: 'Rr Agent',
      launchId: 'rrlaunch-abc',
      title: 'Rr Agent',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      agentStatus: 'ready',
      waiting: false,
      pendingMessages: 0,
      online: false,
      isSubagent: false,
      uiLocale: 'zh-cn',
      lastMessageTs: Date.now(),
      status: 'offline',
    };

    vi.stubEnv('RR_CURSOR_BIN', fakeCursor);
    vi.spyOn(polarProcess, 'registerAndStartRrCursorAgent').mockResolvedValue({
      ok: true,
      id: 'rr-cursor-rr-mcp-agent-test',
      pid: 4242,
    });
    const result = await spawnCursorAgent({ session, workspace: root, headless: true, dataRoot: root });
    expect(result.ok).toBe(true);
    expect(result.workspace).toBe(root);
    expect(result.mode).toBe('headless');
    expect(result.pid).toBe(4242);
    expect(result.polarProcessServiceId).toBe('rr-cursor-rr-mcp-agent-test');
  });

  it('throws when cursor binary missing', async () => {
    vi.stubEnv('RR_CURSOR_BIN', '/no/such/cursor');
    await expect(spawnCursorAgent({
      session: {
        sessionId: 'x',
        name: 'x',
        title: 'x',
        createdAt: 0,
        lastActiveAt: 0,
        agentStatus: 'ready',
        waiting: false,
        pendingMessages: 0,
        online: false,
        isSubagent: false,
        uiLocale: 'zh-cn',
        lastMessageTs: 0,
        status: 'offline',
      },
    })).rejects.toThrow('cursor_cli_not_found');
  });

  it('killCursorAgent rejects invalid pid', () => {
    expect(killCursorAgent(0)).toBe(false);
    expect(killCursorAgent(-1)).toBe(false);
  });
});

describe('defaultRrWorkspace', () => {
  it('prefers explicit workspace', () => {
    expect(defaultRrWorkspace('/tmp/foo')).toBe('/tmp/foo');
  });
});
