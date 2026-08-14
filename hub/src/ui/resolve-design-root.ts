import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { desc, eq } from 'drizzle-orm';
import { type HubDb, projectOwnership } from '../persistence/db.js';

export type ResolveDesignRootResult =
  | { ok: true; root: string; source: 'ownership' | 'fallback' }
  | { ok: false; error: 'no_ownership' | 'empty_path' | 'invalid_path' | 'path_not_allowed' };

function getAllowedRoots(): string[] {
  return ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', homedir()].map((p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  });
}

function isUnderAllowedRoot(real: string): boolean {
  const roots = getAllowedRoots();
  return roots.some((root) => real === root || real.startsWith(root.endsWith('/') ? root : `${root}/`));
}

function isEmptyAgentId(agentId?: string | null): boolean {
  return agentId == null || agentId === '';
}

function resolveAllowedDirectory(
  rawPath: string,
): { ok: true; root: string } | { ok: false; error: 'invalid_path' | 'path_not_allowed' } {
  if (!rawPath.startsWith('/')) {
    return { ok: false, error: 'invalid_path' };
  }
  if (!existsSync(rawPath)) {
    return { ok: false, error: 'invalid_path' };
  }

  let real: string;
  try {
    real = realpathSync(rawPath);
  } catch {
    return { ok: false, error: 'invalid_path' };
  }

  try {
    const st = statSync(real);
    if (!st.isDirectory()) {
      return { ok: false, error: 'invalid_path' };
    }
  } catch {
    return { ok: false, error: 'invalid_path' };
  }

  if (!isUnderAllowedRoot(real)) {
    return { ok: false, error: 'path_not_allowed' };
  }

  return { ok: true, root: real };
}

export function resolveDesignRoot(opts: {
  hubDb: HubDb;
  agentId?: string | null;
  fallbackRoot: string;
}): ResolveDesignRootResult {
  const { hubDb, agentId, fallbackRoot } = opts;

  if (isEmptyAgentId(agentId)) {
    const resolved = resolveAllowedDirectory(fallbackRoot);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    return { ok: true, root: resolved.root, source: 'fallback' };
  }

  const rows = hubDb
    .select()
    .from(projectOwnership)
    .where(eq(projectOwnership.agentId, agentId))
    .orderBy(desc(projectOwnership.registeredAt))
    .all();

  const row = rows.find((entry) => entry.projectPath.trim() !== '');
  if (!row) {
    return { ok: false, error: 'no_ownership' };
  }

  const resolved = resolveAllowedDirectory(row.projectPath.trim());
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }

  return { ok: true, root: resolved.root, source: 'ownership' };
}
