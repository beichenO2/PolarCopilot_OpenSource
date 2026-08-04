import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, patchGlobalConfig, readAllowNewSubagents } from '../../src/rr/orchestrator/config.js';

describe('orchestrator subagent creation policy', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('persists allowNewSubagents without changing unrelated config', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-config-'));
    roots.push(root);
    const path = join(root, 'config.json');
    patchGlobalConfig({ projectRoot: root, pollIntervalMs: 1234, allowNewSubagents: false }, path);

    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(persisted.allowNewSubagents).toBe(false);
    expect(persisted.pollIntervalMs).toBe(1234);
    expect(existsSync(path)).toBe(true);
  });

  it('allows creating new subagents by default for backward compatibility', () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-config-default-'));
    roots.push(root);
    // Default when the policy file is absent (do not use loadConfig(root) — that
    // merges ~/.rr-cursor/orchestrator/config.json and can pick up local pollution).
    const absent = join(root, 'absent-config.json');
    expect(existsSync(absent)).toBe(false);
    expect(readAllowNewSubagents(absent)).toBe(true);
  });
});

