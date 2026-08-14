import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HTTP_TS = join(import.meta.dirname, '../src/transport/http.ts');

describe('p2 http wiring (source-level)', () => {
  const src = readFileSync(HTTP_TS, 'utf8');

  it('imports p2-surface-mount and html-source-mcp', () => {
    expect(src).toMatch(/from\s+['"]\.\.\/ui\/p2-surface-mount\.js['"]/);
    expect(src).toMatch(/from\s+['"]\.\.\/ui\/html-source-mcp\.js['"]/);
  });

  it('registers html-source MCP tool before createMcpServerForHub return', () => {
    expect(src).toMatch(
      /registerHtmlSourceTool\s*\(\s*server\s*,\s*\{\s*hubDb\s*,\s*store\s*,\s*fallbackRoot:\s*mirrorRoot\s*\}\s*\)/,
    );

    const registerIdx = src.indexOf('registerHtmlSourceTool');
    expect(registerIdx).toBeGreaterThanOrEqual(0);

    const returnIdx = src.indexOf('return server;', registerIdx);
    expect(returnIdx).toBeGreaterThan(registerIdx);
  });

  it('mounts P2 surface before mountUiRoutes in mountStreamableHttpHub', () => {
    expect(src).toMatch(
      /mountP2Surface\s*\(\s*app\s*,\s*\{\s*hubDb:\s*deps\.hubDb\s*,\s*mirrorRoot:\s*deps\.mirrorRoot\s*\}\s*\)/,
    );

    const mountP2Idx = src.indexOf('mountP2Surface(app');
    expect(mountP2Idx).toBeGreaterThanOrEqual(0);

    const mountUiIdx = src.indexOf('mountUiRoutes(app, deps.hubDb');
    expect(mountUiIdx).toBeGreaterThanOrEqual(0);

    expect(mountP2Idx).toBeLessThan(mountUiIdx);
  });
});
