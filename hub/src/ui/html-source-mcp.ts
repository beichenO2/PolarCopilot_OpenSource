import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type LoadDesignHtmlSourceResult =
  | { ok: true; path: '_design/index.html'; html: string }
  | { ok: false; error: 'not_found' | 'invalid_root' };

function isValidMirrorRoot(mirrorRoot: string): boolean {
  if (!mirrorRoot || mirrorRoot.trim() === '') {
    return false;
  }
  try {
    return statSync(mirrorRoot).isDirectory();
  } catch {
    return false;
  }
}

export function loadDesignHtmlSource(mirrorRoot: string): LoadDesignHtmlSourceResult {
  if (!isValidMirrorRoot(mirrorRoot)) {
    return { ok: false, error: 'invalid_root' };
  }

  const filePath = join(mirrorRoot, '_design', 'index.html');
  if (!existsSync(filePath)) {
    return { ok: false, error: 'not_found' };
  }

  const html = readFileSync(filePath, 'utf8');
  return { ok: true, path: '_design/index.html', html };
}

export function registerHtmlSourceTool(
  server: { registerTool: McpServer['registerTool'] },
  opts: { mirrorRoot: string },
): void {
  server.registerTool(
    'read_html_source',
    {
      description: 'Read the unique HITL design page `_design/index.html` as HTML source.',
      inputSchema: {},
    },
    async (_raw, extra) => {
      const sessionId = extra.sessionId;
      if (!sessionId) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'missing_session_id' }) }],
          isError: true,
        };
      }

      const result = loadDesignHtmlSource(opts.mirrorRoot);
      if (!result.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    },
  );
}
