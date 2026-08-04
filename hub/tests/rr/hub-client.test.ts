import { afterEach, describe, expect, it, vi } from 'vitest';
import { RrHubClient } from '../../src/rr/orchestrator/hub-client.js';

describe('RrHubClient recovery operations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('respawns an offline Cursor session through the Hub spawn queue', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:8040/api/ui/rr/sessions/session-main/spawn-cursor');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        workspace: '/workspace',
        headless: true,
        waitUntilOnline: false,
      });
      return new Response(JSON.stringify({ ok: true, session: { sessionId: 'session-main' }, spawn: { ok: true } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new RrHubClient({ hubUrl: 'http://127.0.0.1:8040' });
    await (client as unknown as {
      respawnCursor(sessionId: string, workspace: string, headless: boolean): Promise<unknown>;
    }).respawnCursor('session-main', '/workspace', true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
