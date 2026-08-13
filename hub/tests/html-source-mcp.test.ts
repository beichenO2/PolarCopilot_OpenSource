import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('registers read_html_source and handles session / file states', async () => {
    const mirrorRoot = mkdtempSync(join(tmpdir(), 'html-source-mcp-'));
    roots.push(mirrorRoot);
    const html = '<!doctype html><html><body>mcp design</body></html>';
    mkdirSync(join(mirrorRoot, '_design'), { recursive: true });
    writeFileSync(join(mirrorRoot, '_design', 'index.html'), html, 'utf8');

    const calls: Array<{ name: string; def: unknown; handler: Function }> = [];
    const server = {
      registerTool: (name: string, def: unknown, handler: Function) => {
        calls.push({ name, def, handler });
      },
    };

    registerHtmlSourceTool(server as any, { mirrorRoot });

    expect(calls[0]!.name).toBe('read_html_source');
    expect(calls[0]!.def).toMatchObject({
      description: 'Read the unique HITL design page `_design/index.html` as HTML source.',
      inputSchema: {},
    });

    const handler = calls[0]!.handler;

    const missingSession = await handler({}, { sessionId: undefined });
    expect(missingSession).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
      isError: true,
    });

    const ok = await handler({}, { sessionId: 's1' });
    expect(JSON.parse((ok.content as Array<{ text: string }>)[0]!.text)).toEqual({
      ok: true,
      path: '_design/index.html',
      html,
    });
    expect(ok.isError).toBeUndefined();
  });
});
