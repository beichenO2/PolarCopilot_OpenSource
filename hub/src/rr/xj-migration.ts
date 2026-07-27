import { createHash } from 'node:crypto';
import {
  copyFileSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { RrMessage, RrSession, RrSessionStatus } from './types.js';

type JsonObject = Record<string, unknown>;

export interface XjReferenceIssue {
  kind: string;
  source: string;
  target: string;
}

export interface XjReferenceReport {
  brokenRequired: XjReferenceIssue[];
  workspaceOnly: string[];
  sessionOnly: string[];
}

export interface XjTopologyEdge {
  type: 'launch_claim' | 'task_dispatch' | 'subtask_message';
  from: string;
  to: string;
  relationId: string;
}

export interface XjTopology {
  subagentSessionIds: string[];
  edges: XjTopologyEdge[];
}

export interface XjAudit {
  counts: {
    sessions: number;
    historyFiles: number;
    historyRecords: number;
    inbox: number;
    tasks: number;
    subagents: number;
    workspaceRecords: number;
    eventRecords: number;
  };
  idSets: {
    sessionIds: string[];
    messageIds: string[];
    taskIds: string[];
    launchIds: string[];
  };
  bodyHashes: string[];
  references: XjReferenceReport;
  timestamps: number[];
  statusValues: string[];
  topology: XjTopology;
  latestAgentSessionId: string;
}

export interface XjSourceFile {
  relativePath: string;
  sha256: string;
  bytes: number;
}

export interface XjImportPlan {
  sourceRoot: string;
  rrRoot: string;
  audit: XjAudit;
  sourceFiles: XjSourceFile[];
}

export interface XjImportCounts {
  sessions: number;
  historyRecords: number;
  inbox: number;
  tasks: number;
  subagents: number;
}

export interface XjImportResult {
  inserted: XjImportCounts;
  updated: XjImportCounts;
  skipped: XjImportCounts;
  manifestPath: string;
}

export interface XjVerificationReport {
  ok: boolean;
  rawTreeMatch: boolean;
  countsMatch: boolean;
  idSetsMatch: boolean;
  bodyHashesMatch: boolean;
  nativeProjectionMatch: boolean;
  referencesMatch: boolean;
  timestampsAndStatusesMatch: boolean;
  tasksAndPlansMatch: boolean;
  topologyMatch: boolean;
  mismatches: string[];
}

interface LocatedRecord {
  path: string;
  ownerSessionId?: string;
  value: JsonObject;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWrite(path: string, value: string | Buffer, anchor = dirname(path)): void {
  assertNoSymlinkComponents(dirname(path), anchor);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(dirname(path), anchor);
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, path);
}

function atomicWriteExclusive(path: string, value: string | Buffer, anchor = dirname(path)): void {
  assertNoSymlinkComponents(dirname(path), anchor);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(dirname(path), anchor);
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  try {
    linkSync(temporary, path);
  } catch (error) {
    throw Object.assign(new Error(`destination_collision:${path}`), { cause: error });
  } finally {
    rmSync(temporary, { force: true });
  }
}

function atomicJson(path: string, value: unknown, anchor?: string): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`, anchor);
}

const XJ_SESSION_ID = /^(?:xj-mcp-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|xj-mcp-pending-\d+-[0-9a-f]{8})$/;
const XJ_MESSAGE_ID = /^m-\d+-[0-9a-f]{8}$/;
const XJ_TASK_ID = /^t-\d+-[0-9a-f]{8}$/;
const XJ_LAUNCH_ID = /^xjlaunch-\d+-[0-9a-f]{8}$/;

function validatedId(value: unknown, pattern: RegExp, kind: string, path: string): string {
  const id = requireString(value, `${kind}_id`, path);
  if (!pattern.test(id) || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`invalid_${kind}_id:${path}`);
  }
  return id;
}

function xjSessionId(value: unknown, path: string): string {
  return validatedId(value, XJ_SESSION_ID, 'session', path);
}

function xjMessageId(value: unknown, path: string): string {
  return validatedId(value, XJ_MESSAGE_ID, 'message', path);
}

function xjTaskId(value: unknown, path: string): string {
  return validatedId(value, XJ_TASK_ID, 'task', path);
}

function xjLaunchId(value: unknown, path: string): string {
  return validatedId(value, XJ_LAUNCH_ID, 'launch', path);
}

function safeDestination(root: string, segment: string, suffix = '', anchor = root): string {
  const base = resolve(root);
  assertNoSymlinkComponents(base, anchor);
  const candidate = resolve(base, `${segment}${suffix}`);
  if (candidate === base || !candidate.startsWith(`${base}${sep}`)) throw new Error(`unsafe_destination:${segment}`);
  assertNoSymlinkComponents(dirname(candidate), anchor);
  return candidate;
}

function assertNoSymlinkComponents(path: string, anchor = path): void {
  const absolute = resolve(path);
  const floor = resolve(anchor);
  if (absolute !== floor && !absolute.startsWith(`${floor}${sep}`)) throw new Error(`unsafe_destination:${path}`);
  let current = floor;
  const relativeComponents = relative(floor, absolute).split(sep).filter(Boolean);
  for (const component of ['', ...relativeComponents]) {
    if (component) current = join(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`unsafe_destination_symlink:${current}`);
  }
}

function assertRealParentWithin(root: string, path: string): void {
  assertNoSymlinkComponents(root, root);
  assertNoSymlinkComponents(dirname(path), root);
  const rootReal = realpathSync(root);
  const parentReal = realpathSync(dirname(path));
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`unsafe_destination:${path}`);
  }
}

function listFiles(root: string): XjSourceFile[] {
  const output: XjSourceFile[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const entry = lstatSync(path);
      if (entry.isSymbolicLink()) throw new Error(`unsupported_source_symlink:${path}`);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) {
        const bytes = readFileSync(path);
        output.push({ relativePath: relative(root, path), sha256: sha256Buffer(bytes), bytes: bytes.length });
      }
    }
  };
  visit(root);
  return output.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function copyTreeExact(sourceRoot: string, targetRoot: string): void {
  assertNoSymlinkComponents(targetRoot, targetRoot);
  const visit = (source: string) => {
    const target = join(targetRoot, relative(sourceRoot, source));
    const sourceEntry = lstatSync(source);
    if (sourceEntry.isSymbolicLink()) throw new Error(`unsupported_source_symlink:${source}`);
    const stat = statSync(source);
    if (stat.isDirectory()) {
      if (existsSync(target) && !lstatSync(target).isDirectory()) throw new Error(`raw_collision:${target}`);
      assertNoSymlinkComponents(target, targetRoot);
      mkdirSync(target, { recursive: true, mode: 0o700 });
      assertNoSymlinkComponents(target, targetRoot);
      for (const name of readdirSync(source).sort()) visit(join(source, name));
      return;
    }
    if (!stat.isFile()) throw new Error(`unsupported_source_entry:${source}`);
    const sourceBytes = readFileSync(source);
    if (existsSync(target)) {
      const targetEntry = lstatSync(target);
      if (!targetEntry.isFile() || sha256Buffer(readFileSync(target)) !== sha256Buffer(sourceBytes)) {
        throw new Error(`raw_collision:${target}`);
      }
      return;
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(dirname(target), targetRoot);
    const temporary = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    copyFileSync(source, temporary);
    try { linkSync(temporary, target); }
    catch (error) { throw Object.assign(new Error(`raw_collision:${target}`), { cause: error }); }
    finally { rmSync(temporary, { force: true }); }
  };
  visit(sourceRoot);
}

function sourceHash(value: JsonObject): string {
  return sha256(JSON.stringify(value));
}

function importedCompatibility(value: JsonObject): { source: 'xj'; sourceHash: string; raw: JsonObject } {
  return { source: 'xj', sourceHash: sourceHash(value), raw: value };
}

function importedStatus(session: JsonObject): RrSessionStatus {
  if (session.agentStatus === 'session_ended' || session.online === false) return 'offline';
  if (session.waiting === true) return 'waiting';
  if (session.agentStatus === 'developing') return 'working';
  return 'online';
}

function normalizeSession(source: JsonObject, isSubagent: boolean): RrSession {
  return {
    sessionId: xjSessionId(source.sessionId, 'session'),
    name: requireString(source.name, 'name', 'session'),
    ...(typeof source.role === 'string' ? { role: source.role } : {}),
    ...(typeof source.launchId === 'string' ? { launchId: source.launchId } : {}),
    title: typeof source.title === 'string' ? source.title : String(source.name),
    createdAt: Number(source.createdAt ?? 0),
    lastActiveAt: Number(source.lastActiveAt ?? source.createdAt ?? 0),
    agentStatus: String(source.agentStatus ?? 'ready'),
    waiting: source.waiting === true,
    pendingMessages: Number(source.pendingMessages ?? 0),
    online: source.online === true,
    isSubagent,
    uiLocale: typeof source.uiLocale === 'string' ? source.uiLocale : 'zh-cn',
    lastMessageTs: Number(source.lastMessageTs ?? 0),
    status: importedStatus(source),
    compat: importedCompatibility(source),
  };
}

function messageRole(source: JsonObject): RrMessage['role'] {
  if (source.type === 'notice') return 'system';
  if (source.from === 'user' || source.from === 'panel') return 'user';
  return 'assistant';
}

function normalizeMessage(ownerSessionId: string, source: JsonObject): RrMessage {
  const compat = importedCompatibility(source);
  return {
    msgId: xjMessageId(source.msgId, ownerSessionId),
    sessionId: ownerSessionId,
    from: requireString(source.from, 'message_from', ownerSessionId),
    to: requireString(source.to, 'message_to', ownerSessionId),
    role: messageRole(source),
    content: requireString(source.content, 'message_content', ownerSessionId),
    createdAt: Number(source.ts ?? 0),
    metadata: {
      type: 'xj_imported',
      xj: compat,
    },
    compat,
  };
}

function zeroCounts(): XjImportCounts {
  return { sessions: 0, historyRecords: 0, inbox: 0, tasks: 0, subagents: 0 };
}

function existingCompatibility(value: JsonObject): JsonObject | undefined {
  const compat = value.compat;
  return compat && typeof compat === 'object' && !Array.isArray(compat) ? compat as JsonObject : undefined;
}

function writeCompatibleJson(path: string, value: JsonObject, category: keyof XjImportCounts, result: XjImportResult): void {
  if (!existsSync(path)) {
    atomicJson(path, value);
    result.inserted[category] += 1;
    return;
  }
  const existing = readJsonObject(path);
  const incoming = existingCompatibility(value);
  const current = existingCompatibility(existing);
  if (current?.source !== 'xj') throw new Error(`destination_collision:${path}`);
  if (current.sourceHash === incoming?.sourceHash) {
    result.skipped[category] += 1;
    return;
  }
  throw new Error(`destination_collision:${path}`);
}

function requireObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid_json_object:${path}`);
  return value as JsonObject;
}

function requireString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid_${field}:${path}`);
  return value;
}

function readJsonObject(path: string): JsonObject {
  try {
    return requireObject(JSON.parse(readFileSync(path, 'utf8')), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid_json_object:')) throw error;
    throw new Error(`invalid_json:${path}`, { cause: error });
  }
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort().map((name) => join(dir, name));
}

function readJsonLines(path: string): JsonObject[] {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return requireObject(JSON.parse(line), `${path}:${index + 1}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('invalid_json_object:')) throw error;
      throw new Error(`invalid_jsonl:${path}:${index + 1}`, { cause: error });
    }
  });
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function collectTimestamps(value: unknown, key: string | undefined, output: number[]): void {
  if (typeof value === 'number' && key && /^(?:ts|.*At|lastMessageTs)$/.test(key)) output.push(value);
  if (Array.isArray(value)) {
    for (const item of value) collectTimestamps(item, key, output);
  } else if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) collectTimestamps(childValue, childKey, output);
  }
}

function sessionReference(value: unknown): value is string {
  return typeof value === 'string' && /^xj-mcp-(?:agent|pending)-/.test(value);
}

export function auditXjSource(sourceRoot: string): XjAudit {
  const sessionRecords = jsonFiles(join(sourceRoot, 'sessions')).map((path) => ({ path, value: readJsonObject(path) }));
  const sessionsById = new Map<string, JsonObject>();
  for (const record of sessionRecords) {
    const sessionId = xjSessionId(record.value.sessionId, record.path);
    if (sessionsById.has(sessionId)) throw new Error(`duplicate_session_id:${sessionId}`);
    if (basename(record.path, '.json') !== sessionId) throw new Error(`session_filename_mismatch:${record.path}`);
    sessionsById.set(sessionId, record.value);
  }

  const historyFiles = existsSync(join(sourceRoot, 'history'))
    ? readdirSync(join(sourceRoot, 'history')).filter((name) => name.endsWith('.jsonl')).sort()
    : [];
  const historyRecords: LocatedRecord[] = historyFiles.flatMap((name) => {
    const path = join(sourceRoot, 'history', name);
    const ownerSessionId = xjSessionId(basename(name, '.jsonl'), path);
    return readJsonLines(path).map((value) => ({ path, ownerSessionId, value }));
  });

  const inboxRecords: LocatedRecord[] = [];
  const inboxRoot = join(sourceRoot, 'inbox');
  if (existsSync(inboxRoot)) {
    for (const ownerName of readdirSync(inboxRoot).sort()) {
      const ownerSessionId = xjSessionId(ownerName, join(inboxRoot, ownerName));
      const dir = join(inboxRoot, ownerSessionId);
      for (const path of jsonFiles(dir)) inboxRecords.push({ path, ownerSessionId, value: readJsonObject(path) });
    }
  }
  const taskRecords = jsonFiles(join(sourceRoot, 'tasks')).map((path) => ({ path, value: readJsonObject(path) }));
  const subagentRecords = jsonFiles(join(sourceRoot, 'subagents')).map((path) => ({ path, value: readJsonObject(path) }));
  const workspacePath = join(sourceRoot, 'session-workspace.json');
  const workspace = existsSync(workspacePath) ? readJsonObject(workspacePath) : {};
  const eventPath = join(sourceRoot, 'mcp-events.log');
  const events = existsSync(eventPath) ? readJsonLines(eventPath) : [];

  const brokenRequired: XjReferenceIssue[] = [];
  const sessionIds = new Set(sessionsById.keys());
  const requireSession = (kind: string, source: string, target: unknown) => {
    let id: string | undefined;
    try { id = xjSessionId(target, source); } catch { /* reported as a required-reference failure below */ }
    if (!id || !sessionIds.has(id)) {
      brokenRequired.push({ kind, source, target: String(target ?? '') });
    }
  };

  const messageById = new Map<string, JsonObject>();
  const messageIds: string[] = [];
  const bodyHashes: string[] = [];
  for (const record of [...historyRecords, ...inboxRecords]) {
    const msgId = xjMessageId(record.value.msgId, record.path);
    if (record.path.endsWith('.json') && basename(record.path, '.json') !== msgId) {
      throw new Error(`message_filename_mismatch:${record.path}`);
    }
    const content = requireString(record.value.content, 'message_content', record.path);
    const previous = messageById.get(msgId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record.value)) throw new Error(`duplicate_message_id_mismatch:${msgId}`);
    messageById.set(msgId, record.value);
    messageIds.push(msgId);
    bodyHashes.push(sha256(content));
    if (record.ownerSessionId) requireSession('message_owner', record.path, record.ownerSessionId);
    for (const field of ['from', 'to']) {
      const target = record.value[field];
      if (sessionReference(target)) {
        xjSessionId(target, record.path);
        requireSession(`message_${field}`, record.path, target);
      }
    }
  }

  const taskIds: string[] = [];
  const topologyEdges: XjTopologyEdge[] = [];
  for (const record of taskRecords) {
    const taskId = xjTaskId(record.value.taskId, record.path);
    if (basename(record.path, '.json') !== taskId) throw new Error(`task_filename_mismatch:${record.path}`);
    const masterSessionId = xjSessionId(record.value.masterSessionId, record.path);
    const targetSessionId = xjSessionId(record.value.targetSessionId, record.path);
    taskIds.push(taskId);
    requireSession('task_master', taskId, masterSessionId);
    requireSession('task_target', taskId, targetSessionId);
    topologyEdges.push({ type: 'task_dispatch', from: masterSessionId, to: targetSessionId, relationId: taskId });
  }
  if (new Set(taskIds).size !== taskIds.length) throw new Error('duplicate_task_id');

  const subagentSessionIds: string[] = [];
  for (const record of subagentRecords) {
    let sessionId: string;
    try { sessionId = xjSessionId(record.value.sessionId, record.path); }
    catch { throw new Error(`invalid_subagent_id:${record.path}`); }
    if (basename(record.path, '.json') !== sessionId) throw new Error(`subagent_filename_mismatch:${record.path}`);
    subagentSessionIds.push(sessionId);
    requireSession('subagent', record.path, sessionId);
  }

  const pendingByLaunch = new Map<string, string[]>();
  const agentsByLaunch = new Map<string, string[]>();
  const launchIds: string[] = [];
  for (const [sessionId, session] of sessionsById) {
    if (typeof session.launchId !== 'string' || !session.launchId) continue;
    const launchId = xjLaunchId(session.launchId, sessionId);
    launchIds.push(launchId);
    const target = sessionId.startsWith('xj-mcp-pending-') ? pendingByLaunch : agentsByLaunch;
    target.set(launchId, [...(target.get(launchId) ?? []), sessionId]);
  }
  for (const launchId of uniqueSorted(launchIds)) {
    for (const pending of pendingByLaunch.get(launchId) ?? []) {
      for (const agent of agentsByLaunch.get(launchId) ?? []) {
        topologyEdges.push({ type: 'launch_claim', from: pending, to: agent, relationId: launchId });
      }
    }
  }
  for (const record of historyRecords) {
    const subtask = record.value.subtask;
    if (!subtask || typeof subtask !== 'object' || Array.isArray(subtask)) continue;
    const relationId = xjTaskId((subtask as JsonObject).taskId, record.path);
    const from = requireString(record.value.from, 'message_from', record.path);
    const to = requireString(record.value.to, 'message_to', record.path);
    const peer = (subtask as JsonObject).peer;
    if (!taskIds.includes(relationId)) {
      brokenRequired.push({ kind: 'subtask_task', source: record.path, target: relationId });
    }
    if (!sessionReference(peer) || !sessionIds.has(peer) || peer !== from) {
      brokenRequired.push({ kind: 'subtask_peer', source: record.path, target: String(peer ?? '') });
    }
    if (sessionReference(from) && sessionReference(to)) {
      topologyEdges.push({ type: 'subtask_message', from, to, relationId });
    }
  }

  if (brokenRequired.length > 0) {
    throw new Error(`broken_required_reference:${JSON.stringify(brokenRequired)}`);
  }

  const workspaceIds = Object.keys(workspace);
  for (const workspaceId of workspaceIds) xjSessionId(workspaceId, workspacePath);
  const timestamps: number[] = [];
  for (const value of [...sessionsById.values(), ...historyRecords.map((record) => record.value), ...inboxRecords.map((record) => record.value), ...taskRecords.map((record) => record.value), ...subagentRecords.map((record) => record.value), workspace, ...events]) {
    collectTimestamps(value, undefined, timestamps);
  }
  const statusValues = uniqueSorted([
    ...[...sessionsById.values()].flatMap((session) => typeof session.agentStatus === 'string' ? [session.agentStatus] : []),
    ...taskRecords.flatMap((task) => typeof task.value.status === 'string' ? [task.value.status] : []),
  ]);
  const latest = [...sessionsById.entries()]
    .filter(([sessionId]) => sessionId.startsWith('xj-mcp-agent-'))
    .sort(([aId, a], [bId, b]) => (Number(b.lastActiveAt ?? 0) - Number(a.lastActiveAt ?? 0)) || aId.localeCompare(bId))[0];
  if (!latest) throw new Error('no_agent_session');

  return {
    counts: {
      sessions: sessionRecords.length,
      historyFiles: historyFiles.length,
      historyRecords: historyRecords.length,
      inbox: inboxRecords.length,
      tasks: taskRecords.length,
      subagents: subagentRecords.length,
      workspaceRecords: workspaceIds.length,
      eventRecords: events.length,
    },
    idSets: {
      sessionIds: uniqueSorted(sessionIds),
      messageIds: uniqueSorted(messageIds),
      taskIds: uniqueSorted(taskIds),
      launchIds: uniqueSorted(launchIds),
    },
    bodyHashes: uniqueSorted(bodyHashes),
    references: {
      brokenRequired,
      workspaceOnly: workspaceIds.filter((id) => !sessionIds.has(id)).sort(),
      sessionOnly: [...sessionIds].filter((id) => !(id in workspace)).sort(),
    },
    timestamps: [...timestamps].sort((a, b) => a - b),
    statusValues,
    topology: {
      subagentSessionIds: uniqueSorted(subagentSessionIds),
      edges: topologyEdges.sort((a, b) => `${a.type}:${a.from}:${a.to}:${a.relationId}`.localeCompare(`${b.type}:${b.from}:${b.to}:${b.relationId}`)),
    },
    latestAgentSessionId: latest[0],
  };
}

export function planXjImport(sourceRoot: string, rrRoot: string): XjImportPlan {
  const audit = auditXjSource(sourceRoot);
  return { sourceRoot, rrRoot, audit, sourceFiles: listFiles(sourceRoot) };
}

interface JsonImportOperation {
  path: string;
  value: JsonObject;
  category: keyof XjImportCounts;
  action: 'insert' | 'skip';
}

interface HistoryImportOperation {
  path: string;
  additions: RrMessage[];
  skipped: number;
}

function compatibleAction(path: string, value: JsonObject): 'insert' | 'skip' {
  assertNoSymlinkComponents(dirname(path), dirname(path));
  if (!existsSync(path)) return 'insert';
  if (!lstatSync(path).isFile()) throw new Error(`destination_collision:${path}`);
  const existing = readJsonObject(path);
  const incoming = existingCompatibility(value);
  const current = existingCompatibility(existing);
  if (current?.source !== 'xj' || current.sourceHash !== incoming?.sourceHash) {
    throw new Error(`destination_collision:${path}`);
  }
  return 'skip';
}

function importXjToRrLocked(plan: XjImportPlan): XjImportResult {
  const freshAudit = auditXjSource(plan.sourceRoot);
  if (JSON.stringify(freshAudit) !== JSON.stringify(plan.audit)) throw new Error('source_changed_after_plan');
  const freshFiles = listFiles(plan.sourceRoot);
  if (JSON.stringify(freshFiles) !== JSON.stringify(plan.sourceFiles)) throw new Error('source_bytes_changed_after_plan');

  assertNoSymlinkComponents(plan.rrRoot, plan.rrRoot);
  for (const dir of ['sessions', 'history', 'inbox', 'processing', 'subagents', 'tasks', 'task-locks', 'compat/xj']) {
    const destination = join(plan.rrRoot, dir);
    assertNoSymlinkComponents(destination, plan.rrRoot);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(destination, plan.rrRoot);
  }
  const rawRoot = join(plan.rrRoot, 'compat', 'xj', 'raw');
  if (existsSync(rawRoot) && JSON.stringify(listFiles(rawRoot)) !== JSON.stringify(plan.sourceFiles)) {
    throw new Error(`raw_collision:${rawRoot}`);
  }

  const result: XjImportResult = {
    inserted: zeroCounts(),
    updated: zeroCounts(),
    skipped: zeroCounts(),
    manifestPath: join(plan.rrRoot, 'compat', 'xj', 'import-manifest.json'),
  };

  const jsonOperations: JsonImportOperation[] = [];
  const historyOperations: HistoryImportOperation[] = [];
  const subagentIds = new Set(jsonFiles(join(plan.sourceRoot, 'subagents')).map((path) => {
    const source = readJsonObject(path);
    return xjSessionId(source.sessionId, path);
  }));
  for (const path of jsonFiles(join(plan.sourceRoot, 'sessions'))) {
    const source = readJsonObject(path);
    const sessionId = xjSessionId(source.sessionId, path);
    const value = normalizeSession(source, subagentIds.has(sessionId)) as unknown as JsonObject;
    const destination = safeDestination(join(plan.rrRoot, 'sessions'), sessionId, '.json', plan.rrRoot);
    jsonOperations.push({ path: destination, value, category: 'sessions', action: compatibleAction(destination, value) });
  }

  const historyRoot = join(plan.sourceRoot, 'history');
  for (const name of existsSync(historyRoot) ? readdirSync(historyRoot).filter((entry) => entry.endsWith('.jsonl')).sort() : []) {
    const sessionId = xjSessionId(basename(name, '.jsonl'), name);
    const destination = safeDestination(join(plan.rrRoot, 'history'), sessionId, '.jsonl', plan.rrRoot);
    const sourceMessages = readJsonLines(join(historyRoot, name)).map((source) => normalizeMessage(sessionId, source));
    const existingLines = existsSync(destination) ? readFileSync(destination, 'utf8').split('\n').filter(Boolean) : [];
    const existingMessages = existingLines.map((line, index) => {
      try { return requireObject(JSON.parse(line), `${destination}:${index + 1}`); }
      catch (error) { throw new Error(`invalid_rr_history:${destination}:${index + 1}`, { cause: error }); }
    });
    const existingById = new Map(existingMessages.map((message) => [String(message.msgId ?? ''), message]));
    const additions: RrMessage[] = [];
    for (const message of sourceMessages) {
      const existing = existingById.get(message.msgId);
      if (!existing) {
        additions.push(message);
        continue;
      }
      const metadata = existing.metadata;
      const xj = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as JsonObject).xj
        : undefined;
      const incomingXj = (message.metadata as JsonObject).xj as JsonObject;
      if (!xj || typeof xj !== 'object' || Array.isArray(xj) || (xj as JsonObject).sourceHash !== incomingXj.sourceHash) {
        throw new Error(`destination_collision:${destination}:${message.msgId}`);
      }
      // Count only after every destination has passed preflight.
    }
    historyOperations.push({ path: destination, additions, skipped: sourceMessages.length - additions.length });
  }

  const inboxRoot = join(plan.sourceRoot, 'inbox');
  if (existsSync(inboxRoot)) {
    for (const ownerName of readdirSync(inboxRoot).sort()) {
      const sessionId = xjSessionId(ownerName, ownerName);
      for (const path of jsonFiles(join(inboxRoot, sessionId))) {
        const source = readJsonObject(path);
        const message = normalizeMessage(sessionId, source);
        const destinationDir = safeDestination(join(plan.rrRoot, 'inbox'), sessionId, '', plan.rrRoot);
        mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
        const existingPath = readdirSync(destinationDir).filter((name) => name.endsWith('.json')).map((name) => join(destinationDir, name)).find((candidate) => {
          try { return readJsonObject(candidate).msgId === message.msgId; } catch { return false; }
        });
        const destination = existingPath ?? safeDestination(destinationDir, `${message.createdAt}-${message.msgId}`, '.json', plan.rrRoot);
        const value = message as unknown as JsonObject;
        jsonOperations.push({ path: destination, value, category: 'inbox', action: compatibleAction(destination, value) });
      }
    }
  }

  for (const path of jsonFiles(join(plan.sourceRoot, 'tasks'))) {
    const source = readJsonObject(path);
    const taskId = xjTaskId(source.taskId, path);
    const value = { ...source, compat: importedCompatibility(source) };
    const destination = safeDestination(join(plan.rrRoot, 'tasks'), taskId, '.json', plan.rrRoot);
    jsonOperations.push({ path: destination, value, category: 'tasks', action: compatibleAction(destination, value) });
  }
  for (const path of jsonFiles(join(plan.sourceRoot, 'subagents'))) {
    const source = readJsonObject(path);
    const sessionId = xjSessionId(source.sessionId, path);
    const value = { ...source, compat: importedCompatibility(source) };
    const destination = safeDestination(join(plan.rrRoot, 'subagents'), sessionId, '.json', plan.rrRoot);
    jsonOperations.push({ path: destination, value, category: 'subagents', action: compatibleAction(destination, value) });
  }

  copyTreeExact(plan.sourceRoot, rawRoot);
  if (JSON.stringify(listFiles(rawRoot)) !== JSON.stringify(plan.sourceFiles)) throw new Error('raw_tree_copy_mismatch');

  for (const operation of jsonOperations) {
    if (operation.action === 'skip') result.skipped[operation.category] += 1;
    else {
      assertRealParentWithin(plan.rrRoot, operation.path);
      atomicWriteExclusive(operation.path, `${JSON.stringify(operation.value, null, 2)}\n`, plan.rrRoot);
      result.inserted[operation.category] += 1;
    }
  }
  for (const operation of historyOperations) {
    result.skipped.historyRecords += operation.skipped;
    if (operation.additions.length === 0) continue;
    assertRealParentWithin(plan.rrRoot, operation.path);
    if (existsSync(operation.path) && !lstatSync(operation.path).isFile()) throw new Error(`destination_collision:${operation.path}`);
    writeFileSync(operation.path, `${operation.additions.map((message) => JSON.stringify(message)).join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'a',
    });
    result.inserted.historyRecords += operation.additions.length;
  }

  atomicJson(result.manifestPath, {
    schemaVersion: 1,
    sourceRoot: plan.sourceRoot,
    rrRoot: plan.rrRoot,
    sourceFiles: plan.sourceFiles,
    audit: plan.audit,
    lastImport: { inserted: result.inserted, updated: result.updated, skipped: result.skipped },
  }, plan.rrRoot);
  return result;
}

export function importXjToRr(plan: XjImportPlan): XjImportResult {
  assertNoSymlinkComponents(plan.rrRoot, plan.rrRoot);
  mkdirSync(plan.rrRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(plan.rrRoot, plan.rrRoot);
  const lockPath = join(plan.rrRoot, '.xj-import.lock');
  let lock: number;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, 'utf8');
  } catch (error) {
    throw Object.assign(new Error('import_in_progress'), { cause: error });
  }
  try {
    return importXjToRrLocked(plan);
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function importedMessageRecords(rrRoot: string, directory: 'history' | 'inbox'): JsonObject[] {
  const output: JsonObject[] = [];
  const root = join(rrRoot, directory);
  if (!existsSync(root)) return output;
  if (directory === 'history') {
    for (const name of readdirSync(root).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      for (const message of readJsonLines(join(root, name))) {
        const metadata = message.metadata;
        const xj = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as JsonObject).xj : undefined;
        if (xj && typeof xj === 'object' && !Array.isArray(xj) && (xj as JsonObject).source === 'xj') output.push(message);
      }
    }
  } else {
    for (const sessionId of readdirSync(root).sort()) {
      for (const path of jsonFiles(join(root, sessionId))) {
        const message = readJsonObject(path);
        const metadata = message.metadata;
        const xj = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as JsonObject).xj : undefined;
        if (xj && typeof xj === 'object' && !Array.isArray(xj) && (xj as JsonObject).source === 'xj') output.push(message);
      }
    }
  }
  return output;
}

export function verifyXjImport(sourceRoot: string, rrRoot: string, manifestSourceRoot = sourceRoot): XjVerificationReport {
  const sourceAudit = auditXjSource(sourceRoot);
  const rawRoot = join(rrRoot, 'compat', 'xj', 'raw');
  const mismatches: string[] = [];
  const rawTreeMatch = existsSync(rawRoot) && JSON.stringify(listFiles(sourceRoot)) === JSON.stringify(listFiles(rawRoot));
  if (!rawTreeMatch) mismatches.push('raw_tree');
  let rawAudit: XjAudit | undefined;
  try { rawAudit = auditXjSource(rawRoot); } catch { mismatches.push('raw_audit'); }
  let manifestMatches = false;
  const manifestPath = join(rrRoot, 'compat', 'xj', 'import-manifest.json');
  try {
    const manifest = readJsonObject(manifestPath);
    manifestMatches = manifest.schemaVersion === 1
      && resolve(String(manifest.sourceRoot ?? '')) === resolve(manifestSourceRoot)
      && resolve(String(manifest.rrRoot ?? '')) === resolve(rrRoot)
      && JSON.stringify(manifest.sourceFiles) === JSON.stringify(listFiles(sourceRoot))
      && JSON.stringify(manifest.audit) === JSON.stringify(sourceAudit);
  } catch {
    manifestMatches = false;
  }
  if (!manifestMatches) mismatches.push('import_manifest');

  const importedSessions = sourceAudit.idSets.sessionIds.flatMap((sessionId) => {
    const path = join(rrRoot, 'sessions', `${sessionId}.json`);
    if (!existsSync(path)) return [];
    const session = readJsonObject(path);
    return existingCompatibility(session)?.source === 'xj' ? [session] : [];
  });
  const importedHistory = importedMessageRecords(rrRoot, 'history');
  const importedInbox = importedMessageRecords(rrRoot, 'inbox');
  const importedTasks = sourceAudit.idSets.taskIds.flatMap((taskId) => {
    const path = join(rrRoot, 'tasks', `${taskId}.json`);
    return existsSync(path) && existingCompatibility(readJsonObject(path))?.source === 'xj' ? [readJsonObject(path)] : [];
  });
  const importedSubagents = sourceAudit.topology.subagentSessionIds.flatMap((sessionId) => {
    const path = join(rrRoot, 'subagents', `${sessionId}.json`);
    return existsSync(path) && existingCompatibility(readJsonObject(path))?.source === 'xj' ? [readJsonObject(path)] : [];
  });
  const countsMatch = importedSessions.length === sourceAudit.counts.sessions
    && importedHistory.length === sourceAudit.counts.historyRecords
    && importedInbox.length === sourceAudit.counts.inbox
    && importedTasks.length === sourceAudit.counts.tasks
    && importedSubagents.length === sourceAudit.counts.subagents;
  if (!countsMatch) mismatches.push('counts');

  const importedMessageIds = uniqueSorted([...importedHistory, ...importedInbox].map((message) => String(message.msgId ?? '')));
  const idSetsMatch = JSON.stringify(importedSessions.map((session) => String(session.sessionId ?? '')).sort()) === JSON.stringify(sourceAudit.idSets.sessionIds)
    && JSON.stringify(importedMessageIds) === JSON.stringify(sourceAudit.idSets.messageIds)
    && JSON.stringify(importedTasks.map((task) => String(task.taskId ?? '')).sort()) === JSON.stringify(sourceAudit.idSets.taskIds);
  if (!idSetsMatch) mismatches.push('id_sets');

  const importedBodyHashes = uniqueSorted([...importedHistory, ...importedInbox].map((message) => sha256(String(message.content ?? ''))));
  const bodyHashesMatch = JSON.stringify(importedBodyHashes) === JSON.stringify(sourceAudit.bodyHashes);
  if (!bodyHashesMatch) mismatches.push('body_hashes');

  let nativeProjectionMatch = true;
  let nativeReferencesMatch = true;
  let nativeTimestampsAndStatusesMatch = true;
  let nativeTasksAndPlansMatch = true;
  let nativeTopologyMatch = true;
  const note = (label: string, field: string, categories: Array<'references' | 'timestamps' | 'tasks' | 'topology'> = []) => {
    const entry = `${label}:${field}`;
    if (!mismatches.includes(entry)) mismatches.push(entry);
    nativeProjectionMatch = false;
    if (categories.includes('references')) nativeReferencesMatch = false;
    if (categories.includes('timestamps')) nativeTimestampsAndStatusesMatch = false;
    if (categories.includes('tasks')) nativeTasksAndPlansMatch = false;
    if (categories.includes('topology')) nativeTopologyMatch = false;
  };
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const compareCompat = (label: string, compatibility: JsonObject | undefined, source: JsonObject) => {
    if (compatibility?.source !== 'xj') note(label, 'compat.source');
    if (compatibility?.sourceHash !== sourceHash(source)) note(label, 'sourceHash');
    if (!equal(compatibility?.raw, source)) note(label, 'compat.raw');
  };
  const compareField = (
    label: string,
    actual: JsonObject,
    expected: JsonObject,
    field: string,
    categories: Array<'references' | 'timestamps' | 'tasks' | 'topology'> = [],
  ) => {
    if (!equal(actual[field], expected[field])) note(label, field, categories);
  };

  const actualSessions = new Map(importedSessions.map((record) => [String(record.sessionId), record]));
  const subagentIds = new Set(sourceAudit.topology.subagentSessionIds);
  for (const path of jsonFiles(join(sourceRoot, 'sessions'))) {
    const source = readJsonObject(path);
    const sessionId = xjSessionId(source.sessionId, path);
    const actual = actualSessions.get(sessionId);
    if (!actual) continue;
    const expected = normalizeSession(source, subagentIds.has(sessionId)) as unknown as JsonObject;
    const label = `native_session:${sessionId}`;
    compareCompat(label, existingCompatibility(actual), source);
    compareField(label, actual, expected, 'sessionId', ['references']);
    compareField(label, actual, expected, 'launchId', ['references', 'topology']);
    compareField(label, actual, expected, 'createdAt', ['timestamps']);
    compareField(label, actual, expected, 'isSubagent', ['topology']);
    // lastActiveAt/agentStatus/waiting/pendingMessages/online/lastMessageTs/status/name/title are runtime mutable.
  }

  const actualHistory = new Map(importedHistory.map((record) => [`${String(record.sessionId)}\0${String(record.msgId)}`, record]));
  const actualInbox = new Map(importedInbox.map((record) => [`${String(record.sessionId)}\0${String(record.msgId)}`, record]));
  const compareMessage = (ownerSessionId: string, source: JsonObject, actual: JsonObject | undefined) => {
    const msgId = xjMessageId(source.msgId, ownerSessionId);
    if (!actual) return;
    const expected = normalizeMessage(ownerSessionId, source) as unknown as JsonObject;
    const label = `native_message:${msgId}`;
    compareCompat(label, existingCompatibility(actual), source);
    const metadata = actual.metadata;
    const metadataCompat = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
      ? (metadata as JsonObject).xj
      : undefined;
    compareCompat(label, metadataCompat && typeof metadataCompat === 'object' && !Array.isArray(metadataCompat) ? metadataCompat as JsonObject : undefined, source);
    for (const field of ['msgId', 'sessionId', 'from', 'to']) compareField(label, actual, expected, field, ['references']);
    compareField(label, actual, expected, 'createdAt', ['timestamps']);
    compareField(label, actual, expected, 'content');
    compareField(label, actual, expected, 'role');
  };
  const sourceHistoryRoot = join(sourceRoot, 'history');
  if (existsSync(sourceHistoryRoot)) {
    for (const name of readdirSync(sourceHistoryRoot).filter((entry) => entry.endsWith('.jsonl')).sort()) {
      const owner = xjSessionId(basename(name, '.jsonl'), name);
      for (const source of readJsonLines(join(sourceHistoryRoot, name))) {
        const msgId = xjMessageId(source.msgId, name);
        compareMessage(owner, source, actualHistory.get(`${owner}\0${msgId}`));
      }
    }
  }
  const sourceInboxRoot = join(sourceRoot, 'inbox');
  if (existsSync(sourceInboxRoot)) {
    for (const ownerName of readdirSync(sourceInboxRoot).sort()) {
      const owner = xjSessionId(ownerName, ownerName);
      for (const path of jsonFiles(join(sourceInboxRoot, owner))) {
        const source = readJsonObject(path);
        const msgId = xjMessageId(source.msgId, path);
        compareMessage(owner, source, actualInbox.get(`${owner}\0${msgId}`));
      }
    }
  }

  const actualTasks = new Map(importedTasks.map((record) => [String(record.taskId), record]));
  for (const path of jsonFiles(join(sourceRoot, 'tasks'))) {
    const source = readJsonObject(path);
    const taskId = xjTaskId(source.taskId, path);
    const actual = actualTasks.get(taskId);
    if (!actual) continue;
    const label = `native_task:${taskId}`;
    compareCompat(label, existingCompatibility(actual), source);
    for (const field of Object.keys(source)) {
      const categories: Array<'references' | 'timestamps' | 'tasks' | 'topology'> = ['tasks'];
      if (['taskId', 'masterSessionId', 'targetSessionId'].includes(field)) categories.push('references', 'topology');
      if (/At$|^status$/.test(field)) categories.push('timestamps');
      compareField(label, actual, source, field, categories);
    }
  }

  const actualSubagents = new Map(importedSubagents.map((record) => [String(record.sessionId), record]));
  for (const path of jsonFiles(join(sourceRoot, 'subagents'))) {
    const source = readJsonObject(path);
    const sessionId = xjSessionId(source.sessionId, path);
    const actual = actualSubagents.get(sessionId);
    if (!actual) continue;
    const label = `native_subagent:${sessionId}`;
    compareCompat(label, existingCompatibility(actual), source);
    for (const field of Object.keys(source)) {
      const categories: Array<'references' | 'timestamps' | 'tasks' | 'topology'> = ['topology'];
      if (field === 'sessionId') categories.push('references');
      if (/At$/.test(field)) categories.push('timestamps');
      compareField(label, actual, source, field, categories);
    }
  }
  if (!nativeProjectionMatch && !mismatches.includes('native_projection')) mismatches.push('native_projection');

  const sameRawAudit = rawAudit ? JSON.stringify(rawAudit) === JSON.stringify(sourceAudit) : false;
  const referencesMatch = sameRawAudit && rawAudit?.references.brokenRequired.length === 0 && nativeReferencesMatch;
  const timestampsAndStatusesMatch = sameRawAudit
    && JSON.stringify(rawAudit?.timestamps) === JSON.stringify(sourceAudit.timestamps)
    && JSON.stringify(rawAudit?.statusValues) === JSON.stringify(sourceAudit.statusValues)
    && nativeTimestampsAndStatusesMatch;
  const tasksAndPlansMatch = sameRawAudit && nativeTasksAndPlansMatch;
  const topologyMatch = sameRawAudit && JSON.stringify(rawAudit?.topology) === JSON.stringify(sourceAudit.topology) && nativeTopologyMatch;
  if (!referencesMatch) mismatches.push('references');
  if (!timestampsAndStatusesMatch) mismatches.push('timestamps_statuses');
  if (!tasksAndPlansMatch) mismatches.push('tasks_plans');
  if (!topologyMatch) mismatches.push('topology');

  return {
    ok: mismatches.length === 0,
    rawTreeMatch,
    countsMatch,
    idSetsMatch,
    bodyHashesMatch,
    nativeProjectionMatch,
    referencesMatch,
    timestampsAndStatusesMatch,
    tasksAndPlansMatch,
    topologyMatch,
    mismatches,
  };
}
