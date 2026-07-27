import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runXjMigrationCli } from '../../src/rr/xj-migration-cli.js';

const SESSION_ID = 'xj-mcp-agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'xj-cli-source-'));
  for (const dir of ['sessions', 'history', 'inbox', 'tasks', 'subagents']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'sessions', `${SESSION_ID}.json`), `${JSON.stringify({
    sessionId: SESSION_ID,
    name: 'CLI fixture',
    title: 'CLI fixture',
    agentStatus: 'ready',
    createdAt: 100,
    lastActiveAt: 200,
    lastMessageTs: 0,
    online: true,
    waiting: false,
    pendingMessages: 0,
  })}\n`, 'utf8');
  writeFileSync(join(root, 'session-workspace.json'), `${JSON.stringify({
    [SESSION_ID]: { ws: '/fixture', name: 'CLI fixture', createdAt: 100 },
  })}\n`, 'utf8');
  writeFileSync(join(root, 'mcp-events.log'), '', 'utf8');
  return root;
}

describe('XJ migration CLI', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('dry-runs without creating the RR root and writes a body-free report', () => {
    const sourceRoot = fixture();
    const outputRoot = mkdtempSync(join(tmpdir(), 'xj-cli-output-'));
    const rrRoot = join(outputRoot, 'rr-does-not-exist');
    const reportPath = join(outputRoot, 'dry-run.json');
    roots.push(sourceRoot, outputRoot);
    const report = runXjMigrationCli({ mode: 'dry-run', sourceRoot, rrRoot, reportPath });
    expect(report.success).toBe(true);
    expect(report.audit.counts.sessions).toBe(1);
    expect(existsSync(rrRoot)).toBe(false);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ mode: 'dry-run', success: true });
    expect(readFileSync(reportPath, 'utf8')).not.toContain('content');
  });

  it('imports and then verifies through explicit modes', () => {
    const sourceRoot = fixture();
    const outputRoot = mkdtempSync(join(tmpdir(), 'xj-cli-output-'));
    const rrRoot = join(outputRoot, 'rr');
    roots.push(sourceRoot, outputRoot);
    const imported = runXjMigrationCli({ mode: 'import', sourceRoot, rrRoot, reportPath: join(outputRoot, 'import.json') });
    expect(imported.verification?.ok).toBe(true);
    expect(imported.importResult?.inserted.sessions).toBe(1);
    const verified = runXjMigrationCli({ mode: 'verify', sourceRoot, rrRoot, reportPath: join(outputRoot, 'verify.json') });
    expect(verified.verification?.ok).toBe(true);
  });
});

