import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubDatabase, projectOwnership, type HubDb, type HubSqlite } from '../src/persistence/db.js';
import { resolveDesignRoot } from '../src/ui/resolve-design-root.js';

describe('resolveDesignRoot', () => {
  let sqlite: HubSqlite;
  let db: HubDb;
  let dbPath: string;
  let tmpBase: string;
  let fallbackRoot: string;
  let projectRoot: string;
  let olderRoot: string;
  let newerRoot: string;

  beforeEach(() => {
    tmpBase = mkdtempSync(join(tmpdir(), 'pc-resolve-design-root-'));
    dbPath = join(tmpBase, 'hub.sqlite');
    ({ sqlite, db } = createHubDatabase(dbPath));
    fallbackRoot = mkdtempSync(join(tmpdir(), 'pc-fallback-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'pc-project-'));
    olderRoot = mkdtempSync(join(tmpdir(), 'pc-older-'));
    newerRoot = mkdtempSync(join(tmpdir(), 'pc-newer-'));
  });

  afterEach(() => {
    try {
      sqlite.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpBase, { recursive: true, force: true });
    rmSync(fallbackRoot, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(olderRoot, { recursive: true, force: true });
    rmSync(newerRoot, { recursive: true, force: true });
  });

  function insertOwnership(row: {
    projectName: string;
    agentId: string;
    projectPath: string;
    registeredAt: Date;
  }): void {
    db.insert(projectOwnership)
      .values({
        projectName: row.projectName,
        agentId: row.agentId,
        projectPath: row.projectPath,
        registeredAt: row.registeredAt,
      })
      .run();
  }

  it('returns fallback realpath when agentId is absent', () => {
    const result = resolveDesignRoot({
      hubDb: db,
      agentId: undefined,
      fallbackRoot,
    });

    expect(result).toEqual({
      ok: true,
      root: realpathSync(fallbackRoot),
      source: 'fallback',
    });
  });

  it.each([null, ''] as const)('treats %j agentId as absent and uses fallback', (agentId) => {
    const result = resolveDesignRoot({
      hubDb: db,
      agentId,
      fallbackRoot,
    });

    expect(result).toEqual({
      ok: true,
      root: realpathSync(fallbackRoot),
      source: 'fallback',
    });
  });

  it('resolves ownership root from absolute project_path directory', () => {
    insertOwnership({
      projectName: 'proj-a',
      agentId: 'agent-1',
      projectPath: projectRoot,
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({
      ok: true,
      root: realpathSync(projectRoot),
      source: 'ownership',
    });
  });

  it('prefers newer non-empty ownership row by registeredAt', () => {
    insertOwnership({
      projectName: 'proj-old',
      agentId: 'agent-1',
      projectPath: olderRoot,
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });
    insertOwnership({
      projectName: 'proj-new',
      agentId: 'agent-1',
      projectPath: newerRoot,
      registeredAt: new Date('2026-02-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({
      ok: true,
      root: realpathSync(newerRoot),
      source: 'ownership',
    });
  });

  it('skips newer empty project_path and uses older non-empty row', () => {
    insertOwnership({
      projectName: 'proj-old',
      agentId: 'agent-1',
      projectPath: olderRoot,
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });
    insertOwnership({
      projectName: 'proj-new-empty',
      agentId: 'agent-1',
      projectPath: '   ',
      registeredAt: new Date('2026-02-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({
      ok: true,
      root: realpathSync(olderRoot),
      source: 'ownership',
    });
  });

  it('returns no_ownership when agent has no rows even if fallback is valid', () => {
    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'missing-agent',
      fallbackRoot,
    });

    expect(result).toEqual({ ok: false, error: 'no_ownership' });
  });

  it('returns no_ownership when all ownership paths are empty', () => {
    insertOwnership({
      projectName: 'proj-empty',
      agentId: 'agent-1',
      projectPath: '',
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({ ok: false, error: 'no_ownership' });
  });

  it('returns invalid_path for relative project_path', () => {
    insertOwnership({
      projectName: 'proj-rel',
      agentId: 'agent-1',
      projectPath: 'relative/path',
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_path' });
  });

  it('returns invalid_path when project_path directory does not exist', () => {
    insertOwnership({
      projectName: 'proj-missing',
      agentId: 'agent-1',
      projectPath: join(tmpdir(), 'pc-nonexistent-design-root'),
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_path' });
  });

  it('returns invalid_path when fallbackRoot is not a directory', () => {
    const filePath = join(tmpBase, 'not-a-dir');
    writeFileSync(filePath, 'x');

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: undefined,
      fallbackRoot: filePath,
    });

    expect(result).toEqual({ ok: false, error: 'invalid_path' });
  });

  it('returns path_not_allowed when ownership path is outside whitelist roots', () => {
    insertOwnership({
      projectName: 'proj-etc',
      agentId: 'agent-1',
      projectPath: '/etc',
      registeredAt: new Date('2026-01-01T00:00:00Z'),
    });

    const result = resolveDesignRoot({
      hubDb: db,
      agentId: 'agent-1',
      fallbackRoot,
    });

    expect(result).toEqual({ ok: false, error: 'path_not_allowed' });
  });
});
