import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyXjCleanup, scanXjResidue } from '../../src/rr/xj-cleanup.js';
import { runXjCleanupCli } from '../../src/rr/xj-cleanup-cli.js';
import { importXjToRr, planXjImport, verifyXjImport } from '../../src/rr/xj-migration.js';

const SESSION_ID = 'xj-mcp-agent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function checksumLines(root: string): string {
  const rows: string[] = [];
  const visit = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      rows.push(`${sha256File(path)}  ./${relative(root, path)}`);
    }
  };
  visit(root);
  return `${rows.join('\n')}\n`;
}

function createArchive(root: string, home: string, archive: string): void {
  const stage = join(root, 'archive-stage');
  const bundleName = 'xj-offline-test-archive';
  const bundle = join(stage, bundleName);
  const snapshotHome = join(bundle, 'snapshot', home.slice(1));
  mkdirSync(snapshotHome, { recursive: true });
  cpSync(join(home, '.xj-cursor'), join(snapshotHome, '.xj-cursor'), { recursive: true, dereference: false });
  json(join(bundle, 'manifest.json'), {
    schemaVersion: 1,
    archiveName: bundleName,
    sourceRoot: join(home, '.xj-cursor'),
    dataCounts: { sessions: 1, historyRecords: 1, inbox: 1, tasks: 0, subagents: 0 },
  });
  mkdirSync(join(bundle, 'metadata'), { recursive: true });
  const sums = checksumLines(join(home, '.xj-cursor'));
  writeFileSync(join(bundle, 'metadata', 'source-tree.sha256'), sums, 'utf8');
  writeFileSync(join(bundle, 'metadata', 'copied-tree.sha256'), sums, 'utf8');
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', stage, bundleName]);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xj-cleanup-'));
  const home = join(root, 'home');
  const cursorSupport = join(home, 'Library', 'Application Support', 'Cursor');
  const cursor = join(home, '.cursor');
  const archive = join(root, 'archive.tar.gz');
  const gate = join(root, 'gate.json');
  mkdirSync(cursor, { recursive: true });
  json(join(cursor, 'mcp.json'), {
    mcpServers: {
      'xj-chat': { command: 'xj' },
      'polarcop-xj': { command: 'legacy' },
      'rr-chat': { command: 'rr' },
      keep: { command: 'keep' },
    },
  });
  json(join(cursor, 'mcp.json.pre-rr-chat.bak'), { mcpServers: { 'xj-chat': { command: 'xj' }, keep: {} } });
  json(join(cursor, 'extensions', 'extensions.json'), [
    { identifier: { id: 'xingjie.xj-cursor' }, version: '8.3.37' },
    { identifier: { id: 'keep.extension' }, version: '1.0.0' },
  ]);
  json(join(cursor, 'extensions', '.obsolete'), { 'xingjie.xj-cursor-8.3.37': true, 'keep.extension-1.0.0': true });
  mkdirSync(join(cursor, 'extensions', 'xingjie.xj-cursor-8.3.37'), { recursive: true });
  writeFileSync(join(cursor, 'extensions', 'xingjie.xj-cursor-8.3.37', 'package.json'), '{}', 'utf8');
  json(join(cursorSupport, 'User', 'settings.json'), {
    'xjCursor.update.autoInstall': false,
    'xjCursor.mcpStable.enabled': false,
    'editor.fontSize': 14,
  });
  json(join(cursorSupport, 'User', 'globalStorage', 'storage.json'), {
    recentlyViewed: [
      { path: join(cursor, 'extensions', 'xingjie.xj-cursor-8.3.37', 'dist', 'extension.js') },
      { path: '/keep/file.ts' },
    ],
  });
  const databasePath = join(cursorSupport, 'User', 'globalStorage', 'state.vscdb');
  mkdirSync(join(databasePath, '..'), { recursive: true });
  const db = new Database(databasePath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run('xingjie.xj-cursor', '{"enabled":true}');
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run('secret://{"extensionId":"xingjie.xj-cursor","key":"credential"}', Buffer.from('secret'));
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run('mcpService.knownServerIds', JSON.stringify(['user-xj-chat', 'rr-chat']));
  db.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run('keep.key', JSON.stringify({ keep: true }));
  db.close();
  const sourceRoot = join(home, '.xj-cursor', 'chat');
  for (const dir of ['sessions', 'history', 'inbox', 'tasks', 'subagents']) mkdirSync(join(sourceRoot, dir), { recursive: true });
  mkdirSync(join(sourceRoot, 'inbox', SESSION_ID), { recursive: true });
  json(join(sourceRoot, 'sessions', `${SESSION_ID}.json`), {
    sessionId: SESSION_ID,
    name: 'Cleanup fixture',
    title: 'Cleanup fixture',
    agentStatus: 'ready',
    createdAt: 100,
    lastActiveAt: 200,
    lastMessageTs: 150,
    online: true,
    waiting: false,
    pendingMessages: 1,
  });
  writeFileSync(join(sourceRoot, 'history', `${SESSION_ID}.jsonl`), `${JSON.stringify({
    msgId: 'm-100-aaaaaaaa', from: 'user', to: SESSION_ID, seq: 1, ts: 100, type: 'task', content: 'original body',
  })}\n`, 'utf8');
  json(join(sourceRoot, 'inbox', SESSION_ID, 'm-150-bbbbbbbb.json'), {
    msgId: 'm-150-bbbbbbbb', from: 'panel', to: SESSION_ID, seq: 2, ts: 150, type: 'discussion', content: 'resume body',
  });
  json(join(sourceRoot, 'session-workspace.json'), {
    [SESSION_ID]: { ws: '/fixture', name: 'Cleanup fixture', createdAt: 100 },
  });
  writeFileSync(join(sourceRoot, 'mcp-events.log'), '', 'utf8');
  const rrRoot = join(home, '.rr-cursor', 'chat');
  const plan = planXjImport(sourceRoot, rrRoot);
  importXjToRr(plan);
  const verification = verifyXjImport(sourceRoot, rrRoot);
  createArchive(root, home, archive);
  const archiveSha256 = sha256File(archive);
  json(gate, {
    schemaVersion: 2,
    success: true,
    bindings: { home, sourceRoot, rrRoot },
    archive: { path: archive, sha256: archiveSha256 },
    evidence: {
      sourceFiles: plan.sourceFiles,
      sourceAudit: plan.audit,
      verification,
      idempotenceChecks: { zeroMutations: true, rrOnlyTreePreserved: true },
    },
    checks: Object.fromEntries([
      'archiveChecksum', 'rawTree', 'counts', 'bodyHashes', 'idSets', 'nativeProjection', 'references', 'timestampsAndStatuses',
      'tasksAndPlans', 'topology', 'idempotence', 'continueResume', 'continueRouting',
    ].map((key) => [key, true])),
  });
  mkdirSync(join(home, 'Desktop', 'XJ'), { recursive: true });
  writeFileSync(join(home, 'Desktop', 'XJ', 'README.md'), 'xj', 'utf8');
  mkdirSync(join(cursor, 'projects', 'project', 'mcps', 'user-xj-chat'), { recursive: true });
  writeFileSync(join(cursor, 'projects', 'project', 'mcps', 'user-xj-chat', 'cache.json'), '{}', 'utf8');
  const logDir = join(cursorSupport, 'logs', 'stamp', 'window');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'mcp-server-user-xj-chat.log'), 'xj', 'utf8');
  writeFileSync(join(logDir, 'keep.log'), 'keep', 'utf8');
  return { root, home, cursorSupport, sourceRoot, rrRoot, archive, gate, databasePath };
}

describe('guarded XJ cleanup', () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it('refuses cleanup when any hard-gate check is false', () => {
    const layout = fixture();
    roots.push(layout.root);
    const gate = JSON.parse(readFileSync(layout.gate, 'utf8'));
    gate.success = false;
    json(layout.gate, gate);
    expect(() => applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] })).toThrow(/cleanup_gate_failed:success/);
    expect(scanXjResidue({ home: layout.home, cursorSupport: layout.cursorSupport }).active).not.toEqual([]);
  });

  it('refuses cleanup when an individual hard-gate check is false or missing', () => {
    const layout = fixture();
    roots.push(layout.root);
    const gate = JSON.parse(readFileSync(layout.gate, 'utf8'));
    gate.checks.idempotence = false;
    json(layout.gate, gate);
    expect(() => applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] })).toThrow(/cleanup_gate_failed:check:idempotence/);
    gate.checks.idempotence = undefined;
    delete gate.checks.idempotence;
    json(layout.gate, gate);
    expect(() => applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] })).toThrow(/cleanup_gate_failed:check:idempotence/);
  });

  it('rejects forged or stale cleanup evidence before any mutation', () => {
    const layout = fixture();
    roots.push(layout.root);
    const mcpBefore = readFileSync(join(layout.home, '.cursor', 'mcp.json'));
    const dbBefore = readFileSync(layout.databasePath);
    const gate = JSON.parse(readFileSync(layout.gate, 'utf8'));
    gate.evidence.sourceFiles = [];
    gate.checks = Object.fromEntries([
      'archiveChecksum', 'rawTree', 'counts', 'bodyHashes', 'idSets', 'nativeProjection', 'references', 'timestampsAndStatuses',
      'tasksAndPlans', 'topology', 'idempotence', 'continueResume', 'continueRouting',
    ].map((key) => [key, true]));
    json(layout.gate, gate);

    expect(() => applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    })).toThrow(/cleanup_gate_failed:(?:evidence|source_files)/);
    expect(readFileSync(join(layout.home, '.cursor', 'mcp.json'))).toEqual(mcpBefore);
    expect(readFileSync(layout.databasePath)).toEqual(dbBefore);
    expect(scanXjResidue({ home: layout.home, cursorSupport: layout.cursorSupport }).active).not.toEqual([]);
  });

  it('rejects RR-native tampering even when the saved report still says every check passed', () => {
    const layout = fixture();
    roots.push(layout.root);
    const mcpPath = join(layout.home, '.cursor', 'mcp.json');
    const mcpBefore = readFileSync(mcpPath);
    const historyPath = join(layout.rrRoot, 'history', `${SESSION_ID}.jsonl`);
    const messages = readFileSync(historyPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    messages[0].from = 'panel';
    messages[0].createdAt += 1;
    writeFileSync(historyPath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf8');

    expect(() => applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    })).toThrow(/cleanup_gate_failed:(?:evidence_verification|live_verification)/);
    expect(readFileSync(mcpPath)).toEqual(mcpBefore);
  });

  it('rejects a symlinked cleanup tree without touching the link target or local config', () => {
    const layout = fixture();
    roots.push(layout.root);
    const outside = join(layout.root, 'outside');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'XJ-Cursor.log');
    writeFileSync(victim, 'outside must survive', 'utf8');
    const logs = join(layout.cursorSupport, 'logs');
    mkdirSync(logs, { recursive: true });
    symlinkSync(outside, join(logs, 'linked-outside'));
    const mcpBefore = readFileSync(join(layout.home, '.cursor', 'mcp.json'));

    expect(() => applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    })).toThrow(/unsafe_symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('outside must survive');
    expect(readFileSync(join(layout.home, '.cursor', 'mcp.json'))).toEqual(mcpBefore);
  });

  it('rejects a symlinked cleanup root without touching its outside target', () => {
    const layout = fixture();
    roots.push(layout.root);
    const outside = join(layout.root, 'outside-cursor');
    mkdirSync(outside, { recursive: true });
    const victim = join(outside, 'mcp.json');
    writeFileSync(victim, JSON.stringify({ mcpServers: { 'xj-chat': {} } }), 'utf8');
    rmSync(join(layout.home, '.cursor'), { recursive: true, force: true });
    symlinkSync(outside, join(layout.home, '.cursor'));

    expect(() => applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] })).toThrow(/unsafe_symlink/);
    expect(readFileSync(victim, 'utf8')).toContain('xj-chat');
  });

  it('rejects an archive that omits or corrupts the snapshotted XJ payload', () => {
    const layout = fixture();
    roots.push(layout.root);
    const bundle = join(layout.root, 'archive-stage', 'xj-offline-test-archive');
    rmSync(join(bundle, 'snapshot'), { recursive: true, force: true });
    execFileSync('/usr/bin/tar', ['-czf', layout.archive, '-C', join(layout.root, 'archive-stage'), 'xj-offline-test-archive']);
    const gate = JSON.parse(readFileSync(layout.gate, 'utf8'));
    gate.archive.sha256 = sha256File(layout.archive);
    json(layout.gate, gate);
    expect(() => applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] })).toThrow(/cleanup_gate_failed:archive_payload/);
  });

  it('rolls back every file and database when a later cleanup step fails', () => {
    const layout = fixture();
    roots.push(layout.root);
    const mcpPath = join(layout.home, '.cursor', 'mcp.json');
    const settingsPath = join(layout.cursorSupport, 'User', 'settings.json');
    const mcpBefore = readFileSync(mcpPath);
    const settingsBefore = readFileSync(settingsPath);
    const beforeDb = new Database(layout.databasePath, { readonly: true });
    const rowsBefore = beforeDb.prepare('SELECT key, value FROM ItemTable ORDER BY key').all();
    beforeDb.close();

    const brokenPath = join(layout.cursorSupport, 'User', 'workspaceStorage', 'broken', 'state.vscdb');
    mkdirSync(dirname(brokenPath), { recursive: true });
    const broken = new Database(brokenPath);
    broken.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    broken.prepare('INSERT INTO ItemTable(key, value) VALUES (?, ?)').run('xj-cursor-broken', '{"enabled":true}');
    broken.exec("CREATE TRIGGER reject_xj_cleanup BEFORE DELETE ON ItemTable BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END");
    broken.close();

    expect(() => applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    })).toThrow(/cleanup_(?:rolled_back|apply_failed)/);
    expect(readFileSync(mcpPath)).toEqual(mcpBefore);
    expect(readFileSync(settingsPath)).toEqual(settingsBefore);
    const restored = new Database(layout.databasePath, { readonly: true });
    expect(restored.prepare('SELECT key, value FROM ItemTable ORDER BY key').all()).toEqual(rowsBefore);
    restored.close();
    expect(scanXjResidue({ home: layout.home, cursorSupport: layout.cursorSupport }).active).not.toEqual([]);
  });

  it('requires every Cursor state database to be quiescent before changing any file', () => {
    const layout = fixture();
    roots.push(layout.root);
    const mcpPath = join(layout.home, '.cursor', 'mcp.json');
    const mcpBefore = readFileSync(mcpPath);
    const locker = new Database(layout.databasePath);
    locker.exec('BEGIN IMMEDIATE');
    try {
      expect(() => applyXjCleanup({
        home: layout.home,
        cursorSupport: layout.cursorSupport,
        gateReportPath: layout.gate,
        protectedPaths: [layout.archive],
      })).toThrow(/cleanup_quiescence_failed:database_locked_or_invalid/);
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
    expect(readFileSync(mcpPath)).toEqual(mcpBefore);
  });

  it('rolls back and preserves a source tree recreated after atomic quarantine', async () => {
    const layout = fixture();
    roots.push(layout.root);
    const rrParent = join(layout.home, '.rr-cursor');
    const recreated = join(layout.home, '.xj-cursor', 'chat', 'late-marker.txt');
    const child = spawn(process.execPath, ['-e', [
      "const fs=require('node:fs'); const path=require('node:path');",
      'const [rrParent,recreated]=process.argv.slice(1);',
      "process.stdout.write('ready\\n');",
      "const timer=setInterval(()=>{const roots=fs.existsSync(rrParent)?fs.readdirSync(rrParent).filter((name)=>name.startsWith('.xj-cleanup-rollback-')):[];",
      "if(roots.some((name)=>fs.existsSync(path.join(rrParent,name,'quarantined-xj')))){clearInterval(timer);fs.mkdirSync(path.dirname(recreated),{recursive:true});fs.writeFileSync(recreated,'late write');process.exit(0)}},1);",
      'setTimeout(()=>process.exit(2),10000);',
    ].join(''), rrParent, recreated], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(child.stdout!, 'data');
    let thrown: unknown;
    try {
      applyXjCleanup({ home: layout.home, cursorSupport: layout.cursorSupport, gateReportPath: layout.gate, protectedPaths: [layout.archive] });
    } catch (error) {
      thrown = error;
    }
    const [exitCode] = await once(child, 'exit');

    expect(exitCode).toBe(0);
    expect(String(thrown)).toMatch(/cleanup_(?:rolled_back|rollback_failed)/);
    expect(readFileSync(join(layout.sourceRoot, 'history', `${SESSION_ID}.jsonl`), 'utf8')).toContain('original body');
    const preserved = readdirSync(rrParent).filter((name) => name.startsWith('.xj-cleanup-rollback-')).some((name) => {
      const path = join(rrParent, name, 'late-write-xj', 'chat', 'late-marker.txt');
      return existsSync(path) && statSync(path).isFile();
    });
    expect(preserved).toBe(true);
  });

  it('removes only allowlisted XJ state and preserves RR and unrelated user data', () => {
    const layout = fixture();
    roots.push(layout.root);
    const result = applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    });
    expect(result.removed.length).toBeGreaterThan(0);
    expect(scanXjResidue({ home: layout.home, cursorSupport: layout.cursorSupport }).active).toEqual([]);
    const mcp = JSON.parse(readFileSync(join(layout.home, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['rr-chat', 'keep']);
    const mcpBackup = JSON.parse(readFileSync(join(layout.home, '.cursor', 'mcp.json.pre-rr-chat.bak'), 'utf8'));
    expect(mcpBackup).toEqual({ mcpServers: { keep: {} } });
    const settings = JSON.parse(readFileSync(join(layout.cursorSupport, 'User', 'settings.json'), 'utf8'));
    expect(settings).toEqual({ 'editor.fontSize': 14 });
    const extensions = JSON.parse(readFileSync(join(layout.home, '.cursor', 'extensions', 'extensions.json'), 'utf8'));
    expect(extensions).toHaveLength(1);
    expect(extensions[0].identifier.id).toBe('keep.extension');
    expect(readFileSync(join(layout.cursorSupport, 'logs', 'stamp', 'window', 'keep.log'), 'utf8')).toBe('keep');
    const storage = JSON.parse(readFileSync(join(layout.cursorSupport, 'User', 'globalStorage', 'storage.json'), 'utf8'));
    expect(storage.recentlyViewed[0].path).toContain('xingjie.xj-cursor');
    expect(result.retainedHistoricalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ database: join(layout.cursorSupport, 'User', 'globalStorage', 'storage.json'), key: 'recentlyViewed' }),
    ]));
    const db = new Database(layout.databasePath, { readonly: true });
    expect(db.prepare('SELECT key FROM ItemTable ORDER BY key').all()).toEqual([
      { key: 'keep.key' },
      { key: 'mcpService.knownServerIds' },
    ]);
    expect(JSON.parse(String(db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('mcpService.knownServerIds')!.value))).toEqual(['rr-chat']);
    db.close();
    expect(sha256File(layout.archive)).toBe(JSON.parse(readFileSync(layout.gate, 'utf8')).archive.sha256);
  });

  it('removes SQLite WAL and SHM sidecars after quiescent database cleanup', () => {
    const layout = fixture();
    roots.push(layout.root);
    const walPath = `${layout.databasePath}-wal`;
    const shmPath = `${layout.databasePath}-shm`;
    writeFileSync(walPath, 'xj WAL residue', 'utf8');
    writeFileSync(shmPath, 'xj SHM residue', 'utf8');

    applyXjCleanup({
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
    });

    expect(existsSync(walPath)).toBe(false);
    expect(existsSync(shmPath)).toBe(false);
  });

  it('writes a machine-readable apply and post-scan report', () => {
    const layout = fixture();
    roots.push(layout.root);
    const reportPath = join(layout.root, 'cleanup-report.json');
    const report = runXjCleanupCli({
      mode: 'apply',
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      gateReportPath: layout.gate,
      protectedPaths: [layout.archive],
      reportPath,
    });
    expect(report.success).toBe(true);
    expect(report.postScan.active).toEqual([]);
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ mode: 'apply', success: true });
  });

  it('creates a bound v2 hard gate from live evidence instead of caller booleans', () => {
    const layout = fixture();
    roots.push(layout.root);
    const reportPath = join(layout.root, 'fresh-hard-gate.json');
    const report = runXjCleanupCli({
      mode: 'gate',
      home: layout.home,
      cursorSupport: layout.cursorSupport,
      archivePath: layout.archive,
      protectedPaths: [layout.archive],
      reportPath,
    } as never);
    expect(report.success).toBe(true);
    expect(report.mode).toBe('gate');
    expect((report as unknown as { gate: Record<string, unknown> }).gate).toMatchObject({ schemaVersion: 2, success: true });
    expect((report as unknown as { gate: { checks: Record<string, boolean>; evidence: Record<string, unknown> } }).gate.checks.idempotence).toBe(true);
    expect((report as unknown as { gate: { evidence: { idempotenceChecks: Record<string, boolean> } } }).gate.evidence.idempotenceChecks).toEqual({
      zeroMutations: true,
      rrOnlyTreePreserved: true,
    });
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({
      mode: 'gate',
      success: true,
      gate: {
        schemaVersion: 2,
        bindings: { home: layout.home, sourceRoot: layout.sourceRoot, rrRoot: layout.rrRoot },
        archive: { path: layout.archive },
        evidence: { verification: { ok: true, nativeProjectionMatch: true, tasksAndPlansMatch: true } },
      },
    });
  });
});
