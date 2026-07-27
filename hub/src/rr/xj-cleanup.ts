import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { importXjToRr, planXjImport, verifyXjImport, type XjAudit, type XjSourceFile, type XjVerificationReport } from './xj-migration.js';
import { RrFileStore } from './store.js';

const ACTIVE_DB_VALUE_KEYS = new Set([
  '__$__targetStorageMarker',
  'cursor/markdownEditorModePreferences',
  'history.recentlyOpenedPathsList',
  'mcpService.knownServerIds',
  'memento/webviewViews.origins',
  'workbench.customize.primitiveSourceSnapshot.mcps.v3',
  'workbench.welcomePage.walkthroughMetadata',
]);

const ACTIVE_STORAGE_VALUE_KEYS = new Set([
  'mcpService.knownServerIds',
  'workbench.customize.primitiveSourceSnapshot.mcps.v3',
  'memento/webviewViews.origins',
  'workbench.welcomePage.walkthroughMetadata',
]);

export interface XjCleanupLayout {
  home: string;
  cursorSupport?: string;
}

export interface XjCleanupOptions extends XjCleanupLayout {
  gateReportPath: string;
  protectedPaths: string[];
}

export interface XjCleanupResult {
  removed: string[];
  updated: string[];
  retainedHistoricalRows: Array<{ database: string; key: string }>;
}

export interface XjResidueReport {
  active: string[];
  retainedHistoricalRows: Array<{ database: string; key: string }>;
}

export interface XjCleanupGate {
  schemaVersion?: number;
  createdAt?: string;
  success?: boolean;
  bindings?: { home?: string; sourceRoot?: string; rrRoot?: string };
  archive?: { path?: string; sha256?: string };
  evidence?: {
    sourceFiles?: XjSourceFile[];
    sourceAudit?: XjAudit;
    verification?: XjVerificationReport;
    idempotenceChecks?: EvaluatedCleanupEvidence['idempotenceChecks'];
  };
  checks?: Record<string, boolean>;
}

export interface XjCleanupGateOptions extends XjCleanupLayout {
  archivePath: string;
}

interface EvaluatedCleanupEvidence {
  sourceFiles: XjSourceFile[];
  sourceAudit: XjAudit;
  verification: XjVerificationReport;
  continueChecks: {
    latestSession: boolean;
    fullHistory: boolean;
    linkedTasksAndStatuses: boolean;
    workspace: boolean;
    topology: boolean;
    sameInboxTarget: boolean;
    sameHistoryTarget: boolean;
  };
  idempotenceChecks: {
    zeroMutations: boolean;
    rrOnlyTreePreserved: boolean;
  };
  evidenceId: string;
}

interface CleanupSnapshot {
  target: string;
  backup: string;
}

const REQUIRED_GATE_CHECKS = [
  'archiveChecksum',
  'rawTree',
  'counts',
  'bodyHashes',
  'idSets',
  'nativeProjection',
  'references',
  'timestampsAndStatuses',
  'tasksAndPlans',
  'topology',
  'idempotence',
  'continueResume',
  'continueRouting',
] as const;

function containsXj(value: string): boolean {
  return /xingjie\.xj-cursor|xj-cursor|xjCursor\.|\bxj-chat\b|polarcop-xj|xj-mcp-server|\/Desktop\/XJ(?:\/|$)/i.test(value);
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function archiveMember(archivePath: string, member: string): string {
  return execFileSync('/usr/bin/tar', ['-xOf', archivePath, member], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function archiveMemberBytes(archivePath: string, member: string): Buffer {
  return execFileSync('/usr/bin/tar', ['-xOf', archivePath, member], { maxBuffer: 64 * 1024 * 1024 });
}

function validateOfflineArchive(archivePath: string, home: string, audit: XjAudit, sourceFiles: XjSourceFile[]): void {
  let listing: string;
  let verbose: string;
  try {
    listing = execFileSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    verbose = execFileSync('/usr/bin/tar', ['-tvzf', archivePath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw Object.assign(new Error('cleanup_gate_failed:archive_format'), { cause: error });
  }
  const members = listing.split('\n').filter(Boolean);
  if (members.length === 0) throw new Error('cleanup_gate_failed:archive_empty');
  for (const member of members) {
    if (member.startsWith('/') || member.split('/').includes('..') || member.includes('\0')) {
      throw new Error(`cleanup_gate_failed:archive_unsafe_member:${member}`);
    }
  }
  for (const line of verbose.split('\n').filter(Boolean)) {
    if (/^[lh]/.test(line)) throw new Error('cleanup_gate_failed:archive_link_member');
  }
  const root = members[0]!.split('/')[0]!;
  const manifestName = `${root}/manifest.json`;
  const sourceSumsName = `${root}/metadata/source-tree.sha256`;
  const copiedSumsName = `${root}/metadata/copied-tree.sha256`;
  for (const required of [manifestName, sourceSumsName, copiedSumsName]) {
    if (!members.includes(required)) throw new Error(`cleanup_gate_failed:archive_missing:${required}`);
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(archiveMember(archivePath, manifestName)) as Record<string, unknown>; }
  catch (error) { throw Object.assign(new Error('cleanup_gate_failed:archive_manifest'), { cause: error }); }
  if (resolve(String(manifest.sourceRoot ?? '')) !== resolve(home, '.xj-cursor')) {
    throw new Error('cleanup_gate_failed:archive_source_binding');
  }
  const counts = manifest.dataCounts as Record<string, unknown> | undefined;
  const expectedCounts = {
    sessions: audit.counts.sessions,
    historyRecords: audit.counts.historyRecords,
    inbox: audit.counts.inbox,
    tasks: audit.counts.tasks,
    subagents: audit.counts.subagents,
  };
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) throw new Error('cleanup_gate_failed:archive_counts');

  const parseSums = (text: string) => new Map(text.split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (!match) throw new Error('cleanup_gate_failed:archive_checksum_manifest');
    return [match[2]!, match[1]!] as const;
  }));
  const sourceSums = parseSums(archiveMember(archivePath, sourceSumsName));
  const copiedSums = parseSums(archiveMember(archivePath, copiedSumsName));
  const snapshotPrefix = `${root}/snapshot/${resolve(home).slice(1)}/.xj-cursor/chat/`;
  for (const file of sourceFiles) {
    const key = `./chat/${file.relativePath}`;
    if (sourceSums.get(key) !== file.sha256 || copiedSums.get(key) !== file.sha256) {
      throw new Error(`cleanup_gate_failed:archive_source_checksum:${file.relativePath}`);
    }
    const payloadMember = `${snapshotPrefix}${file.relativePath}`;
    if (!members.includes(payloadMember)) throw new Error(`cleanup_gate_failed:archive_payload_missing:${file.relativePath}`);
    if (sha256Bytes(archiveMemberBytes(archivePath, payloadMember)) !== file.sha256) {
      throw new Error(`cleanup_gate_failed:archive_payload_checksum:${file.relativePath}`);
    }
  }
}

function treeDigest(root: string): string {
  const rows: string[] = [];
  const visit = (path: string) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`unsafe_symlink:${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      return;
    }
    if (entry.isFile()) {
      const relativePath = path.slice(root.length + 1);
      if (relativePath === 'compat/xj/import-manifest.json' || relativePath === '.xj-import.lock') return;
      rows.push(`${relativePath}\0${sha256Bytes(readFileSync(path))}`);
    }
  };
  visit(root);
  return sha256Bytes(rows.join('\n'));
}

function evaluateIdempotence(sourceRoot: string, rrRoot: string): EvaluatedCleanupEvidence['idempotenceChecks'] {
  const parent = mkdtempSync(join(dirname(rrRoot), '.xj-idempotence-'));
  const clone = join(parent, 'chat');
  try {
    cpSync(rrRoot, clone, { recursive: true, dereference: false, preserveTimestamps: true });
    const before = treeDigest(clone);
    const first = importXjToRr(planXjImport(sourceRoot, clone));
    const second = importXjToRr(planXjImport(sourceRoot, clone));
    const after = treeDigest(clone);
    const zero = [first, second].every((result) => Object.values(result.inserted).every((value) => value === 0)
      && Object.values(result.updated).every((value) => value === 0));
    return { zeroMutations: zero, rrOnlyTreePreserved: before === after };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function evaluateContinueTakeover(rrRoot: string, audit: XjAudit): EvaluatedCleanupEvidence['continueChecks'] {
  const cloneParent = mkdtempSync(join(dirname(rrRoot), '.xj-continue-gate-'));
  const cloneRoot = join(cloneParent, 'chat');
  try {
    cpSync(rrRoot, cloneRoot, { recursive: true, dereference: false, preserveTimestamps: true });
    rmSync(join(cloneRoot, 'resume-leases'), { recursive: true, force: true });
    mkdirSync(join(cloneRoot, 'resume-leases'), { recursive: true, mode: 0o700 });
    const store = new RrFileStore(cloneRoot, { offlineAfterMs: Number.MAX_SAFE_INTEGER });
    const owner = `cleanup-gate-${process.pid}`;
    const resume = store.register({ name: 'continue' }, owner).resume;
    if (!resume) throw new Error('cleanup_gate_failed:continue_missing');
    const selectedId = resume.session.sessionId;
    const importedHistory = resume.history.filter((message) => message.compat?.source === 'xj').map((message) => message.compat!.raw);
    const sourceHistoryPath = join(cloneRoot, 'compat', 'xj', 'raw', 'history', `${selectedId}.jsonl`);
    const sourceHistory = existsSync(sourceHistoryPath)
      ? readFileSync(sourceHistoryPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    const rawTasksRoot = join(cloneRoot, 'compat', 'xj', 'raw', 'tasks');
    const linkedTasks = existsSync(rawTasksRoot) ? readdirSync(rawTasksRoot).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
      const task = json(join(rawTasksRoot, name)) as Record<string, unknown>;
      return task.masterSessionId === selectedId || task.targetSessionId === selectedId ? [task] : [];
    }) : [];
    const workspacePath = join(cloneRoot, 'compat', 'xj', 'raw', 'session-workspace.json');
    const expectedWorkspace = existsSync(workspacePath)
      ? (json(workspacePath) as Record<string, unknown>)[selectedId]
      : undefined;

    const marker = `cleanup-gate-route-${process.pid}-${Date.now()}`;
    const acknowledgement = `${marker}-ack`;
    store.enqueueUserMessage(selectedId, marker);
    let routed = false;
    for (let index = 0; index < audit.counts.inbox + 2; index += 1) {
      store.claimAvailableMessageForOwner(selectedId, owner);
      const processingDir = join(cloneRoot, 'processing', selectedId);
      const claimed = existsSync(processingDir) ? readdirSync(processingDir).filter((name) => name.endsWith('.json')).sort()[0] : undefined;
      if (!claimed) break;
      const message = json(join(processingDir, claimed)) as Record<string, unknown>;
      if (message.content === marker) {
        store.reply(selectedId, acknowledgement, {}, owner);
        routed = true;
        break;
      }
      store.reply(selectedId, 'cleanup gate acknowledged pre-existing message', { visibility: 'internal' }, owner);
    }
    const inboxDir = join(cloneRoot, 'inbox', selectedId);
    const markerStillInInbox = existsSync(inboxDir) && readdirSync(inboxDir).some((name) => {
      try { return (json(join(inboxDir, name)) as Record<string, unknown>).content === marker; } catch { return false; }
    });
    const historyPath = join(cloneRoot, 'history', `${selectedId}.jsonl`);
    const historyText = existsSync(historyPath) ? readFileSync(historyPath, 'utf8') : '';
    const markerInHistory = historyText.includes(marker);
    const replyInHistory = historyText.includes(acknowledgement);
    return {
      latestSession: selectedId === audit.latestAgentSessionId,
      fullHistory: JSON.stringify(importedHistory) === JSON.stringify(sourceHistory),
      linkedTasksAndStatuses: JSON.stringify(resume.tasks) === JSON.stringify(linkedTasks),
      workspace: JSON.stringify(resume.workspace) === JSON.stringify(expectedWorkspace),
      topology: JSON.stringify(resume.topology) === JSON.stringify(audit.topology),
      sameInboxTarget: routed && !markerStillInInbox,
      sameHistoryTarget: markerInHistory && replyInHistory,
    };
  } finally {
    rmSync(cloneParent, { recursive: true, force: true });
  }
}

function evaluateCleanupEvidence(sourceRoot: string, rrRoot: string, manifestSourceRoot = sourceRoot): EvaluatedCleanupEvidence {
  const plan = planXjImport(sourceRoot, rrRoot);
  const verification = verifyXjImport(sourceRoot, rrRoot, manifestSourceRoot);
  const continueChecks = evaluateContinueTakeover(rrRoot, plan.audit);
  const idempotenceChecks = evaluateIdempotence(sourceRoot, rrRoot);
  const measured = { sourceFiles: plan.sourceFiles, sourceAudit: plan.audit, verification, continueChecks, idempotenceChecks };
  return { ...measured, evidenceId: sha256Bytes(JSON.stringify(measured)) };
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.xj-cleanup.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function sanitizeJson(value: unknown): unknown {
  if (typeof value === 'string') return containsXj(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const cleaned = sanitizeJson(item);
      if (cleaned === undefined) return [];
      if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned as object).length === 0) return [];
      return [cleaned];
    });
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (containsXj(key)) continue;
      const cleaned = sanitizeJson(child);
      if (cleaned !== undefined) output[key] = cleaned;
    }
    return output;
  }
  return value;
}

function sanitizeActiveStorage(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (containsXj(key)) continue;
    output[key] = ACTIVE_STORAGE_VALUE_KEYS.has(key) ? sanitizeJson(child) : child;
  }
  return output;
}

function walk(root: string, callback: (path: string, isDirectory: boolean) => boolean | void, rejectSymlinks = false): void {
  if (!existsSync(root)) return;
  const visit = (path: string) => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) {
      if (rejectSymlinks) throw new Error(`unsafe_symlink:${path}`);
      callback(path, false);
      return;
    }
    const directory = statSync(path).isDirectory();
    const descend = callback(path, directory);
    if (!directory || descend === false || !existsSync(path)) return;
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  visit(root);
}

function assertNoSymlinkComponents(path: string, anchor: string): void {
  const absolute = resolve(path);
  const floor = resolve(anchor);
  if (absolute !== floor && !absolute.startsWith(`${floor}${sep}`)) throw new Error(`unsafe_cleanup_path:${path}`);
  let current = floor;
  for (const component of ['', ...relative(floor, absolute).split(sep).filter(Boolean)]) {
    if (component) current = join(current, component);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`unsafe_symlink:${current}`);
  }
}

function assertCleanupRoots(home: string, cursorSupport: string): void {
  const canonicalHome = resolve(home);
  const canonicalSupport = resolve(cursorSupport);
  if (canonicalSupport !== canonicalHome && !canonicalSupport.startsWith(`${canonicalHome}${sep}`)) {
    throw new Error(`unsafe_cleanup_path:${cursorSupport}`);
  }
  assertNoSymlinkComponents(join(canonicalHome, '.cursor'), canonicalHome);
  assertNoSymlinkComponents(canonicalSupport, canonicalHome);
}

function stateDatabases(cursorSupport: string, rejectSymlinks = false): string[] {
  const output: string[] = [];
  walk(join(cursorSupport, 'User'), (path, isDirectory) => {
    if (!isDirectory && path.endsWith(`${sep}state.vscdb`)) output.push(path);
  }, rejectSymlinks);
  return output.sort();
}

export function createXjCleanupGate(options: XjCleanupGateOptions): XjCleanupGate {
  const home = resolve(options.home);
  const sourceRoot = join(home, '.xj-cursor', 'chat');
  const rrRoot = join(home, '.rr-cursor', 'chat');
  const archivePath = resolve(options.archivePath);
  if (!existsSync(archivePath) || lstatSync(archivePath).isSymbolicLink() || !lstatSync(archivePath).isFile()) {
    throw new Error('cleanup_gate_failed:archive');
  }
  const evidence = evaluateCleanupEvidence(sourceRoot, rrRoot);
  if (!evidence.verification.ok || Object.values(evidence.continueChecks).some((value) => value !== true)) {
    throw new Error('cleanup_gate_failed:live_evidence');
  }
  validateOfflineArchive(archivePath, home, evidence.sourceAudit, evidence.sourceFiles);
  return {
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    success: true,
    bindings: { home, sourceRoot, rrRoot },
    archive: { path: archivePath, sha256: sha256Bytes(readFileSync(archivePath)) },
    evidence: {
      sourceFiles: evidence.sourceFiles,
      sourceAudit: evidence.sourceAudit,
      verification: evidence.verification,
      idempotenceChecks: evidence.idempotenceChecks,
    },
    checks: {
      archiveChecksum: true,
      rawTree: evidence.verification.rawTreeMatch,
      counts: evidence.verification.countsMatch,
      bodyHashes: evidence.verification.bodyHashesMatch,
      idSets: evidence.verification.idSetsMatch,
      nativeProjection: evidence.verification.nativeProjectionMatch,
      references: evidence.verification.referencesMatch,
      timestampsAndStatuses: evidence.verification.timestampsAndStatusesMatch,
      tasksAndPlans: evidence.verification.tasksAndPlansMatch,
      topology: evidence.verification.topologyMatch,
      idempotence: evidence.idempotenceChecks.zeroMutations && evidence.idempotenceChecks.rrOnlyTreePreserved,
      continueResume: evidence.continueChecks.latestSession
        && evidence.continueChecks.fullHistory
        && evidence.continueChecks.linkedTasksAndStatuses
        && evidence.continueChecks.workspace
        && evidence.continueChecks.topology,
      continueRouting: evidence.continueChecks.sameInboxTarget && evidence.continueChecks.sameHistoryTarget,
    },
  };
}

function assertGate(options: XjCleanupOptions): { gate: XjCleanupGate; evidence: EvaluatedCleanupEvidence } {
  const gate = json(options.gateReportPath) as XjCleanupGate;
  if (gate.success !== true) throw new Error('cleanup_gate_failed:success');
  if (gate.schemaVersion !== 2) throw new Error('cleanup_gate_failed:schema');
  for (const check of REQUIRED_GATE_CHECKS) {
    if (gate.checks?.[check] !== true) throw new Error(`cleanup_gate_failed:check:${check}`);
  }
  const home = resolve(options.home);
  const sourceRoot = join(home, '.xj-cursor', 'chat');
  const rrRoot = join(home, '.rr-cursor', 'chat');
  if (resolve(String(gate.bindings?.home ?? '')) !== home
    || resolve(String(gate.bindings?.sourceRoot ?? '')) !== sourceRoot
    || resolve(String(gate.bindings?.rrRoot ?? '')) !== rrRoot) {
    throw new Error('cleanup_gate_failed:bindings');
  }
  const archivePath = gate.archive?.path;
  const expected = gate.archive?.sha256;
  if (!archivePath || !expected || !existsSync(archivePath)) throw new Error('cleanup_gate_failed:archive');
  if (lstatSync(archivePath).isSymbolicLink() || !lstatSync(archivePath).isFile()) throw new Error('cleanup_gate_failed:archive_type');
  const actual = sha256Bytes(readFileSync(archivePath));
  if (actual !== expected) throw new Error('cleanup_gate_failed:archive_checksum');
  const evidence = evaluateCleanupEvidence(sourceRoot, rrRoot);
  if (JSON.stringify(gate.evidence?.sourceFiles) !== JSON.stringify(evidence.sourceFiles)) {
    throw new Error('cleanup_gate_failed:source_files');
  }
  if (JSON.stringify(gate.evidence?.sourceAudit) !== JSON.stringify(evidence.sourceAudit)) {
    throw new Error('cleanup_gate_failed:source_audit');
  }
  if (JSON.stringify(gate.evidence?.verification) !== JSON.stringify(evidence.verification)) {
    throw new Error('cleanup_gate_failed:evidence_verification');
  }
  if (JSON.stringify(gate.evidence?.idempotenceChecks) !== JSON.stringify(evidence.idempotenceChecks)) {
    throw new Error('cleanup_gate_failed:evidence_idempotence');
  }
  if (!evidence.verification.ok
    || !evidence.verification.nativeProjectionMatch
    || !evidence.verification.tasksAndPlansMatch) {
    throw new Error('cleanup_gate_failed:live_verification');
  }
  if (Object.values(evidence.continueChecks).some((value) => value !== true)) {
    throw new Error('cleanup_gate_failed:continue');
  }
  if (Object.values(evidence.idempotenceChecks).some((value) => value !== true)) {
    throw new Error('cleanup_gate_failed:idempotence');
  }
  validateOfflineArchive(archivePath, home, evidence.sourceAudit, evidence.sourceFiles);
  return { gate, evidence };
}

function isProtected(path: string, protectedPaths: string[]): boolean {
  const canonical = (value: string) => existsSync(value) ? realpathSync(value) : resolve(value);
  const candidate = canonical(path);
  return protectedPaths.map(canonical).some((protectedPath) =>
    candidate === protectedPath
    || candidate.startsWith(`${protectedPath}${sep}`)
    || protectedPath.startsWith(`${candidate}${sep}`));
}

function assertCursorStopped(home: string): void {
  if (resolve(home) !== resolve(homedir())) return;
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const cursor = processes.split('\n').filter((line) =>
    /\/Cursor\.app\/Contents\/(?:MacOS\/Cursor|Frameworks\/Cursor Helper)/.test(line)
    || /xingjie\.xj-cursor|xj-mcp-server\.cjs|user-xj-chat/.test(line));
  if (cursor.length > 0) throw new Error(`cleanup_quiescence_failed:cursor_running:${cursor.map((line) => line.trim().split(/\s+/)[0]).join(',')}`);
}

function preflightDatabases(databasePaths: string[]): void {
  for (const path of databasePaths) {
    let database: Database.Database;
    try { database = new Database(path); }
    catch (error) { throw Object.assign(new Error(`cleanup_quiescence_failed:database_open:${path}`), { cause: error }); }
    try {
      database.pragma('busy_timeout = 100');
      database.exec('BEGIN IMMEDIATE');
      const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
      if (table) database.prepare('SELECT key, value FROM ItemTable LIMIT 1').all();
      database.exec('ROLLBACK');
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* best effort before close */ }
      throw Object.assign(new Error(`cleanup_quiescence_failed:database_locked_or_invalid:${path}`), { cause: error });
    } finally {
      database.close();
    }
  }
}

function cleanupTargets(home: string, cursorSupport: string): { targets: string[]; databases: string[] } {
  assertCleanupRoots(home, cursorSupport);
  const cursor = join(home, '.cursor');
  const targets = new Set<string>();
  const add = (path: string) => { if (existsSync(path)) targets.add(resolve(path)); };
  for (const path of [
    join(cursor, 'mcp.json'),
    join(cursorSupport, 'User', 'settings.json'),
    join(cursor, 'extensions', 'extensions.json'),
    join(cursor, 'extensions', '.obsolete'),
    join(cursorSupport, 'User', 'globalStorage', 'storage.json'),
    join(home, '.xj-cursor'),
    join(home, 'Desktop', 'XJ'),
  ]) add(path);

  const extensionRoot = join(cursor, 'extensions');
  if (existsSync(extensionRoot)) {
    walk(extensionRoot, (path, isDirectory) => {
      if (isDirectory && /^xingjie\.xj-cursor-/i.test(path.split(sep).at(-1) ?? '')) {
        add(path);
      }
    }, true);
  }
  if (existsSync(cursor)) {
    for (const name of readdirSync(cursor)) {
      if (name === 'mcp.json' || !name.startsWith('mcp.json')) continue;
      const path = join(cursor, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`unsafe_symlink:${path}`);
      if (entry.isFile() && containsXj(readFileSync(path, 'utf8'))) add(path);
    }
  }
  walk(join(cursor, 'projects'), (path, isDirectory) => {
    if (isDirectory && ['user-xj-chat', 'user-polarcop-xj'].includes(path.split(sep).at(-1) ?? '')) {
      add(path);
    }
  }, true);
  walk(join(cursorSupport, 'logs'), (path, isDirectory) => {
    if (!isDirectory && /(?:^|\/)(?:\d+-)?XJ-Cursor\.log$|mcp-server-user-(?:xj-chat|polarcop-xj)|MCP user-(?:xj-chat|polarcop-xj)\.log$/i.test(path)) add(path);
  }, true);
  const databases = stateDatabases(cursorSupport, true);
  for (const path of databases) {
    add(path);
    add(`${path}-wal`);
    add(`${path}-shm`);
  }

  const sorted = [...targets].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const nonNested = sorted.filter((candidate, index) => !sorted.slice(0, index).some((parent) => candidate.startsWith(`${parent}${sep}`)));
  for (const path of nonNested) if (lstatSync(path).isSymbolicLink()) throw new Error(`unsafe_symlink:${path}`);
  return { targets: nonNested, databases };
}

function snapshotTargets(targets: string[], home: string, protectedPaths: string[]): { root: string; snapshots: CleanupSnapshot[] } {
  const rollbackParent = join(home, '.rr-cursor');
  mkdirSync(rollbackParent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(rollbackParent, '.xj-cleanup-rollback-'));
  const snapshots: CleanupSnapshot[] = [];
  try {
    targets.forEach((target, index) => {
      // SQLite may remove a stale WAL/SHM sidecar while the quiescence
      // preflight opens the database. Snapshot only paths that still exist.
      if (!existsSync(target)) return;
      assertNoSymlinkComponents(target, home);
      if (isProtected(target, protectedPaths)) throw new Error(`protected_path:${target}`);
      if (lstatSync(target).isSymbolicLink()) throw new Error(`unsafe_symlink:${target}`);
      const backup = join(root, String(index));
      cpSync(target, backup, { recursive: true, dereference: false, preserveTimestamps: true });
      snapshots.push({ target, backup });
    });
    return { root, snapshots };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function restoreSnapshots(snapshots: CleanupSnapshot[]): void {
  for (const snapshot of [...snapshots].reverse()) {
    rmSync(snapshot.target, { recursive: true, force: true });
    mkdirSync(dirname(snapshot.target), { recursive: true, mode: 0o700 });
    cpSync(snapshot.backup, snapshot.target, { recursive: true, dereference: false, preserveTimestamps: true });
  }
}

function databaseCleanup(databasePath: string, result: XjCleanupResult): void {
  const database = new Database(databasePath);
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
    if (!table) return;
    const rows = database.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: string; value: string | Buffer }>;
    const remove = database.prepare('DELETE FROM ItemTable WHERE key = ?');
    const update = database.prepare('UPDATE ItemTable SET value = ? WHERE key = ?');
    database.transaction(() => {
      for (const row of rows) {
        if (containsXj(row.key)) {
          remove.run(row.key);
          result.updated.push(`${databasePath}#delete:${row.key}`);
          continue;
        }
        const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
        if (!containsXj(text)) continue;
        if (!ACTIVE_DB_VALUE_KEYS.has(row.key)) {
          result.retainedHistoricalRows.push({ database: databasePath, key: row.key });
          continue;
        }
        try {
          const cleaned = sanitizeJson(JSON.parse(text));
          const serialized = JSON.stringify(cleaned);
          if (containsXj(serialized)) throw new Error('marker_remains');
          update.run(serialized, row.key);
          result.updated.push(`${databasePath}#update:${row.key}`);
        } catch {
          remove.run(row.key);
          result.updated.push(`${databasePath}#delete-cache:${row.key}`);
        }
      }
    })();
  } finally {
    database.close();
  }
}

function applyXjCleanupMutations(options: XjCleanupOptions, protectedPaths: string[]): XjCleanupResult {
  const home = resolve(options.home);
  const cursorSupport = resolve(options.cursorSupport ?? join(home, 'Library', 'Application Support', 'Cursor'));
  const cursor = join(home, '.cursor');
  assertCleanupRoots(home, cursorSupport);
  const result: XjCleanupResult = { removed: [], updated: [], retainedHistoricalRows: [] };
  const remove = (path: string) => {
    if (!existsSync(path)) return;
    if (isProtected(path, protectedPaths)) throw new Error(`protected_path:${path}`);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`unsafe_symlink:${path}`);
    rmSync(path, { recursive: true, force: true });
    result.removed.push(path);
  };

  const mcpPath = join(cursor, 'mcp.json');
  if (existsSync(mcpPath)) {
    const value = json(mcpPath) as { mcpServers?: Record<string, unknown> };
    if (value.mcpServers && typeof value.mcpServers === 'object') {
      const before = JSON.stringify(value);
      delete value.mcpServers['xj-chat'];
      delete value.mcpServers['polarcop-xj'];
      if (JSON.stringify(value) !== before) {
        atomicJson(mcpPath, value);
        result.updated.push(mcpPath);
      }
    }
  }

  const settingsPath = join(cursorSupport, 'User', 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = json(settingsPath) as Record<string, unknown>;
    const before = JSON.stringify(settings);
    for (const key of Object.keys(settings)) if (/^xjCursor\./i.test(key)) delete settings[key];
    if (JSON.stringify(settings) !== before) {
      atomicJson(settingsPath, settings);
      result.updated.push(settingsPath);
    }
  }

  const extensionsPath = join(cursor, 'extensions', 'extensions.json');
  if (existsSync(extensionsPath)) {
    const extensions = json(extensionsPath);
    if (Array.isArray(extensions)) {
      const cleaned = extensions.filter((entry) => {
        if (!entry || typeof entry !== 'object') return true;
        const identifier = (entry as { identifier?: { id?: string } }).identifier?.id ?? '';
        return identifier.toLowerCase() !== 'xingjie.xj-cursor';
      });
      if (cleaned.length !== extensions.length) {
        atomicJson(extensionsPath, cleaned);
        result.updated.push(extensionsPath);
      }
    }
  }
  const obsoletePath = join(cursor, 'extensions', '.obsolete');
  if (existsSync(obsoletePath)) {
    const obsolete = json(obsoletePath);
    const cleaned = sanitizeJson(obsolete);
    if (JSON.stringify(cleaned) !== JSON.stringify(obsolete)) {
      atomicJson(obsoletePath, cleaned);
      result.updated.push(obsoletePath);
    }
  }
  const extensionRoot = join(cursor, 'extensions');
  if (existsSync(extensionRoot)) {
    for (const name of readdirSync(extensionRoot)) if (/^xingjie\.xj-cursor-/i.test(name)) remove(join(extensionRoot, name));
  }

  const storagePath = join(cursorSupport, 'User', 'globalStorage', 'storage.json');
  if (existsSync(storagePath)) {
    const storage = json(storagePath);
    if (storage && typeof storage === 'object' && !Array.isArray(storage)) {
      for (const [key, value] of Object.entries(storage)) {
        if (!containsXj(key) && !ACTIVE_STORAGE_VALUE_KEYS.has(key) && containsXj(JSON.stringify(value))) {
          result.retainedHistoricalRows.push({ database: storagePath, key });
        }
      }
    }
    const cleaned = sanitizeActiveStorage(storage);
    if (JSON.stringify(cleaned) !== JSON.stringify(storage)) {
      atomicJson(storagePath, cleaned);
      result.updated.push(storagePath);
    }
  }
  for (const databasePath of stateDatabases(cursorSupport, true)) {
    databaseCleanup(databasePath, result);
    // Cursor is stopped and this database connection is closed. Remove stale
    // sidecars so old WAL pages cannot retain XJ payloads after cleanup.
    remove(`${databasePath}-wal`);
    remove(`${databasePath}-shm`);
  }

  if (existsSync(cursor)) {
    for (const name of readdirSync(cursor)) {
      if (name === 'mcp.json' || !name.startsWith('mcp.json')) continue;
      const path = join(cursor, name);
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error(`unsafe_symlink:${path}`);
        if (!statSync(path).isFile()) continue;
        const text = readFileSync(path, 'utf8');
        if (!containsXj(text)) continue;
        try {
          const cleaned = sanitizeJson(JSON.parse(text));
          const serialized = JSON.stringify(cleaned);
          if (cleaned === undefined || containsXj(serialized)) {
            remove(path);
          } else {
            atomicJson(path, cleaned);
            result.updated.push(path);
          }
        } catch {
          // Opaque or malformed backups cannot be edited safely; remove them
          // rather than retaining an XJ payload.
          remove(path);
        }
      } catch {
        // Unreadable unrelated backup is not an XJ deletion candidate.
      }
    }
  }

  walk(join(cursor, 'projects'), (path, isDirectory) => {
    if (isDirectory && ['user-xj-chat', 'user-polarcop-xj'].includes(path.split(sep).at(-1) ?? '')) {
      remove(path);
      return false;
    }
  }, true);
  walk(join(cursorSupport, 'logs'), (path, isDirectory) => {
    if (!isDirectory && /(?:^|\/)(?:\d+-)?XJ-Cursor\.log$|mcp-server-user-(?:xj-chat|polarcop-xj)|MCP user-(?:xj-chat|polarcop-xj)\.log$/i.test(path)) remove(path);
  }, true);

  remove(join(home, 'Desktop', 'XJ'));
  return result;
}

export function applyXjCleanup(options: XjCleanupOptions): XjCleanupResult {
  const home = resolve(options.home);
  const lockParent = join(home, '.rr-cursor');
  mkdirSync(lockParent, { recursive: true, mode: 0o700 });
  const lockPath = join(lockParent, '.xj-cleanup.lock');
  let lock: number;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, 'utf8');
  } catch (error) {
    throw Object.assign(new Error('cleanup_in_progress'), { cause: error });
  }
  try {
    const { gate, evidence } = assertGate(options);
    const archivePath = gate.archive?.path as string;
    const protectedPaths = [...options.protectedPaths, archivePath, join(home, '.rr-cursor')];
    assertCursorStopped(home);
    const cursorSupport = resolve(options.cursorSupport ?? join(home, 'Library', 'Application Support', 'Cursor'));
    const plan = cleanupTargets(home, cursorSupport);
    preflightDatabases(plan.databases);
    const sourceTree = join(home, '.xj-cursor');
    const sourceRoot = join(sourceTree, 'chat');
    const rrRoot = join(home, '.rr-cursor', 'chat');
    const beforeMutation = evaluateCleanupEvidence(sourceRoot, rrRoot);
    if (beforeMutation.evidenceId !== evidence.evidenceId) throw new Error('cleanup_gate_failed:evidence_changed_before_apply');
    if (sha256Bytes(readFileSync(archivePath)) !== gate.archive?.sha256) throw new Error('cleanup_gate_failed:archive_changed_before_apply');

    const journal = snapshotTargets(plan.targets.filter((target) => resolve(target) !== resolve(sourceTree)), home, protectedPaths);
    const quarantinedTree = join(journal.root, 'quarantined-xj');
    let quarantined = false;
    try {
      renameSync(sourceTree, quarantinedTree);
      quarantined = true;
      assertCursorStopped(home);
      if (existsSync(sourceTree)) throw new Error('cleanup_gate_failed:source_recreated_after_quarantine');
      const quarantinedEvidence = evaluateCleanupEvidence(join(quarantinedTree, 'chat'), rrRoot, sourceRoot);
      if (quarantinedEvidence.evidenceId !== evidence.evidenceId) throw new Error('cleanup_gate_failed:evidence_changed_after_quarantine');
      validateOfflineArchive(archivePath, home, quarantinedEvidence.sourceAudit, quarantinedEvidence.sourceFiles);

      const result = applyXjCleanupMutations(options, protectedPaths);
      assertCursorStopped(home);
      if (existsSync(sourceTree)) throw new Error('cleanup_gate_failed:source_recreated_during_apply');
      const finalEvidence = evaluateCleanupEvidence(join(quarantinedTree, 'chat'), rrRoot, sourceRoot);
      if (finalEvidence.evidenceId !== evidence.evidenceId) throw new Error('cleanup_gate_failed:evidence_changed_before_source_delete');
      validateOfflineArchive(archivePath, home, finalEvidence.sourceAudit, finalEvidence.sourceFiles);
      if (sha256Bytes(readFileSync(archivePath)) !== gate.archive?.sha256) throw new Error('cleanup_gate_failed:archive_changed_before_source_delete');
      const postScan = scanXjResidue({ home, cursorSupport });
      if (postScan.active.length > 0) throw new Error(`post_cleanup_residue:${JSON.stringify(postScan.active)}`);
      result.removed.push(sourceTree);
      rmSync(journal.root, { recursive: true, force: true });
      return result;
    } catch (error) {
      try {
        let lateWritePath: string | undefined;
        if (existsSync(sourceTree)) {
          lateWritePath = join(journal.root, 'late-write-xj');
          renameSync(sourceTree, lateWritePath);
        }
        if (quarantined && existsSync(quarantinedTree)) renameSync(quarantinedTree, sourceTree);
        restoreSnapshots(journal.snapshots);
        if (!lateWritePath) rmSync(journal.root, { recursive: true, force: true });
        else throw new Error(`late_source_preserved:${lateWritePath}`);
      } catch (rollbackError) {
        throw Object.assign(new Error('cleanup_rollback_failed'), { cause: { error, rollbackError } });
      }
      throw Object.assign(new Error(`cleanup_rolled_back:${error instanceof Error ? error.message : String(error)}`), { cause: error });
    }
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

export function scanXjResidue(layout: XjCleanupLayout): XjResidueReport {
  const home = resolve(layout.home);
  const cursorSupport = resolve(layout.cursorSupport ?? join(home, 'Library', 'Application Support', 'Cursor'));
  const cursor = join(home, '.cursor');
  const active: string[] = [];
  const retainedHistoricalRows: Array<{ database: string; key: string }> = [];
  const add = (value: string) => { if (!active.includes(value)) active.push(value); };

  for (const path of [join(home, '.xj-cursor'), join(home, 'Desktop', 'XJ')]) if (existsSync(path)) add(path);
  const mcpPath = join(cursor, 'mcp.json');
  if (existsSync(mcpPath)) {
    const value = json(mcpPath) as { mcpServers?: Record<string, unknown> };
    for (const key of ['xj-chat', 'polarcop-xj']) if (value.mcpServers?.[key]) add(`${mcpPath}#${key}`);
  }
  const settingsPath = join(cursorSupport, 'User', 'settings.json');
  if (existsSync(settingsPath)) {
    const value = json(settingsPath) as Record<string, unknown>;
    for (const key of Object.keys(value)) if (/^xjCursor\./i.test(key)) add(`${settingsPath}#${key}`);
  }
  const extensionRoot = join(cursor, 'extensions');
  if (existsSync(extensionRoot)) {
    for (const name of readdirSync(extensionRoot)) if (/^xingjie\.xj-cursor-/i.test(name)) add(join(extensionRoot, name));
  }
  for (const registry of [join(extensionRoot, 'extensions.json'), join(extensionRoot, '.obsolete')]) {
    if (existsSync(registry) && containsXj(readFileSync(registry, 'utf8'))) add(registry);
  }
  const storagePath = join(cursorSupport, 'User', 'globalStorage', 'storage.json');
  if (existsSync(storagePath) && containsXj(readFileSync(storagePath, 'utf8'))) {
    try {
      const storage = json(storagePath);
      if (storage && typeof storage === 'object' && !Array.isArray(storage)) {
        for (const [key, value] of Object.entries(storage)) {
          if (containsXj(key) || (ACTIVE_STORAGE_VALUE_KEYS.has(key) && containsXj(JSON.stringify(value)))) add(`${storagePath}#${key}`);
          else if (containsXj(JSON.stringify(value))) retainedHistoricalRows.push({ database: storagePath, key });
        }
      }
    } catch {
      add(storagePath);
    }
  }
  if (existsSync(cursor)) {
    for (const name of readdirSync(cursor)) {
      if (name === 'mcp.json' || !name.startsWith('mcp.json')) continue;
      const path = join(cursor, name);
      try { if (statSync(path).isFile() && containsXj(readFileSync(path, 'utf8'))) add(path); } catch { /* ignore */ }
    }
  }
  walk(join(cursor, 'projects'), (path, isDirectory) => {
    if (isDirectory && ['user-xj-chat', 'user-polarcop-xj'].includes(path.split(sep).at(-1) ?? '')) add(path);
  });
  walk(join(cursorSupport, 'logs'), (path, isDirectory) => {
    if (!isDirectory && /(?:^|\/)(?:\d+-)?XJ-Cursor\.log$|mcp-server-user-(?:xj-chat|polarcop-xj)|MCP user-(?:xj-chat|polarcop-xj)\.log$/i.test(path)) add(path);
  });
  for (const databasePath of stateDatabases(cursorSupport)) {
    let database: Database.Database;
    try { database = new Database(databasePath, { readonly: true }); } catch { continue; }
    try {
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ItemTable'").get()) continue;
      const rows = database.prepare('SELECT key, value FROM ItemTable').all() as Array<{ key: string; value: string | Buffer }>;
      for (const row of rows) {
        if (containsXj(row.key)) add(`${databasePath}#${row.key}`);
        else {
          const text = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value);
          if (!containsXj(text)) continue;
          if (ACTIVE_DB_VALUE_KEYS.has(row.key)) add(`${databasePath}#${row.key}`);
          else retainedHistoricalRows.push({ database: databasePath, key: row.key });
        }
      }
    } finally {
      database.close();
    }
  }
  return { active: active.sort(), retainedHistoricalRows };
}
