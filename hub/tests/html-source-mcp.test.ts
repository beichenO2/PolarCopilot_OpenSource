import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHubDatabase,
  projectOwnership,
  type HubDb,
  type HubSqlite,
} from '../src/persistence/db.js';
import { loadDesignHtmlSource, registerHtmlSourceTool } from '../src/ui/html-source-mcp.js';

describe('loadDesignHtmlSource', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('returns not_found when _design/index.html is missing', () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'html-source-'));
    roots.push(mirrorRoot);

    expect(loadDesignHtmlSource(mirrorRoot)).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns full UTF-8 html when _design/index.html exists', () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'html-source-'));
    roots.push(mirrorRoot);
    const html = '<!doctype html><html><body>design gate</body></html>';
    const designDir = join(mirrorRoot, '_design');
    mkdirSync(designDir, { recursive: true });
    writeFileSync(join(designDir, 'index.html'), html, 'utf8');

    expect(loadDesignHtmlSource(mirrorRoot)).toEqual({
      ok: true,
      path: '_design/index.html',
      html,
    });
  });

  it('only reads _design/index.html under the given mirrorRoot (join behavior)', () => {
    const base = mkdtempSync(join(tmpdir(), 'html-source-'));
    roots.push(base);

    const projectRoot = join(base, 'project');
    const otherRoot = join(base, 'other');
    mkdirSync(join(projectRoot, '_design'), { recursive: true });
    mkdirSync(join(otherRoot, '_design'), { recursive: true });
    writeFileSync(join(projectRoot, '_design', 'index.html'), '<html>project</html>', 'utf8');
    writeFileSync(join(otherRoot, '_design', 'index.html'), '<html>other</html>', 'utf8');
    writeFileSync(join(base, 'secret.html'), '<html>secret</html>', 'utf8');

    const traversalRoot = join(projectRoot, '..', 'other');
    const result = loadDesignHtmlSource(traversalRoot);

    expect(result).toEqual({
      ok: true,
      path: '_design/index.html',
      html: '<html>other</html>',
    });
    expect(existsSync(join(base, 'secret.html'))).toBe(true);
  });

  it('returns invalid_root for empty mirrorRoot', () => {
    expect(loadDesignHtmlSource('')).toEqual({ ok: false, error: 'invalid_root' });
  });

  it('returns invalid_root when mirrorRoot is not a directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'html-source-'));
    roots.push(base);
    const filePath = join(base, 'not-a-dir');
    writeFileSync(filePath, 'x', 'utf8');

    expect(loadDesignHtmlSource(filePath)).toEqual({ ok: false, error: 'invalid_root' });
  });
});

describe('registerHtmlSourceTool', () => {
  let sqlite: HubSqlite;
  let hubDb: HubDb;
  let dbPath: string;
  let tmpBase: string;
  let fallbackRoot: string;
  let projectRoot: string;
  const roots: string[] = [];

  const store = {
    getSessionByMcpId: (id: string) => (id === 's1' ? { agentId: 'agent-ps' } : undefined),
  };

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'html-source-mcp-'));
    roots.push(tmpBase);
    dbPath = join(tmpBase, 'hub.sqlite');
    ({ sqlite, db: hubDb } = createHubDatabase(dbPath));
    fallbackRoot = mkdtempSync(join(tmpdir(), 'html-source-fallback-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'html-source-project-'));
    roots.push(fallbackRoot, projectRoot);
  });

  afterEach(() => {
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  function writeDesignHtml(root: string, html: string): void {
    mkdirSync(join(root, '_design'), { recursive: true });
    writeFileSync(join(root, '_design', 'index.html'), html, 'utf8');
  }

  function registerAndGetHandler() {
    const calls: Array<{ name: string; def: unknown; handler: Function }> = [];
    const server = {
      registerTool: (name: string, def: unknown, handler: Function) => {
        calls.push({ name, def, handler });
      },
    };

    registerHtmlSourceTool(server as any, { hubDb, store, fallbackRoot });

    expect(calls[0]!.name).toBe('read_html_source');
    expect(calls[0]!.def).toMatchObject({
      description: 'Read the unique HITL design page `_design/index.html` as HTML source.',
      inputSchema: {},
    });

    return calls[0]!.handler;
  }

  it('returns missing_session_id when sessionId is absent', async () => {
    const handler = registerAndGetHandler();

    const missingSession = await handler({}, { sessionId: undefined });
    expect(missingSession).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
      isError: true,
    });
  });

  it('returns not_registered when session is unknown', async () => {
    const handler = registerAndGetHandler();

    const notRegistered = await handler({}, { sessionId: 'unknown' });
    expect(notRegistered).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'not_registered' }) }],
      isError: true,
    });
  });

  it('returns ownership project html instead of fallbackRoot', async () => {
    const fallbackHtml = '<html>fallback design</html>';
    const projectHtml = '<html>ownership project design</html>';
    writeDesignHtml(fallbackRoot, fallbackHtml);
    writeDesignHtml(projectRoot, projectHtml);

    hubDb
      .insert(projectOwnership)
      .values({
        projectName: 'owned-proj',
        agentId: 'agent-ps',
        projectPath: projectRoot,
        registeredAt: new Date('2026-01-01T00:00:00Z'),
      })
      .run();

    const handler = registerAndGetHandler();
    const ok = await handler({}, { sessionId: 's1' });

    expect(JSON.parse((ok.content as Array<{ text: string }>)[0]!.text)).toEqual({
      ok: true,
      path: '_design/index.html',
      html: projectHtml,
    });
    expect(ok.isError).toBeUndefined();
  });

  it('returns no_ownership isError even when fallbackRoot has design html', async () => {
    writeDesignHtml(fallbackRoot, '<html>fallback design</html>');

    const handler = registerAndGetHandler();
    const result = await handler({}, { sessionId: 's1' });

    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'no_ownership' }) }],
      isError: true,
    });
  });
});
