import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createAutomation } from './automation.js';
import type {
  XjAutomation,
  XjAgentSlot,
  XjMessage,
  XjProgress,
  XjSession,
  XjSessionStatus,
} from './types.js';

interface StoreOptions {
  staleAfterMs?: number;
  offlineAfterMs?: number;
  claimTimeoutMs?: number;
}

interface RegisterInput {
  clientKey?: string;
  sessionId?: string;
  launchId?: string;
  name?: string;
  role?: string;
  parentSessionId?: string;
  agentSlot?: XjAgentSlot;
  title?: string;
  modes?: string[];
}

interface WaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface WaitResult {
  kind: 'message' | 'timeout' | 'paused' | 'completed' | 'aborted';
  message?: XjMessage;
  continueWith: 'wait_message' | null;
}

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFLINE_MS = 90_000;
const DEFAULT_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
const EMPTY_PROGRESS: XjProgress = {
  percent: 0,
  summary: '',
  todo: [],
  evidence: [],
  updatedAt: new Date(0).toISOString(),
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

function safeSessionId(value: string): string {
  if (!/^xj-(?:[a-f0-9]{16}|mcp-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)) {
    throw new Error('invalid_session_id');
  }
  return value;
}

function launchSessionId(launchId: string): string {
  const digest = createHash('sha256').update(launchId).digest('hex');
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return `xj-mcp-agent-${uuid}`;
}

function legacySessionId(clientKey: string): string {
  return `xj-${createHash('sha256').update(clientKey).digest('hex').slice(0, 16)}`;
}

function isSessionDir(value: string): boolean {
  try { safeSessionId(value); return true; } catch { return false; }
}

function childLaunchId(parentLaunchId: string, ordinal: number): string {
  const digest = createHash('sha256').update(`${parentLaunchId}:subagent:${ordinal}`).digest('hex');
  return `xjlaunch-${digest.slice(0, 13)}-${digest.slice(13, 21)}`;
}

export class XjFileStore {
  readonly root: string;
  private readonly staleAfterMs: number;
  private readonly offlineAfterMs: number;
  private readonly claimTimeoutMs: number;
  private readonly activeClaims = new Map<string, Set<string>>();
  private lastMessageOrdinal = 0;

  constructor(root: string, options: StoreOptions = {}) {
    this.root = root;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_MS;
    this.offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_MS;
    this.claimTimeoutMs = options.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
    mkdirSync(join(root, 'sessions'), { recursive: true, mode: 0o700 });
  }

  register(input: RegisterInput): { session: XjSession; deduplicated: boolean } {
    const launchId = input.launchId?.trim();
    const requestedSessionId = input.sessionId?.trim();
    const legacyClientKey = input.clientKey?.trim();
    if (launchId && launchId.length > 1024) throw new Error('invalid_launch_id');
    if (legacyClientKey && legacyClientKey.length > 1024) throw new Error('invalid_client_key');
    if (!launchId && !legacyClientKey && !requestedSessionId) throw new Error('invalid_registration');

    const id = requestedSessionId
      ? safeSessionId(requestedSessionId)
      : launchId
        ? launchSessionId(launchId)
        : legacySessionId(legacyClientKey!);
    const dir = this.sessionDir(id);
    const existed = existsSync(join(dir, 'session.json'));
    if (requestedSessionId && !existed) throw new Error('session_not_found');
    mkdirSync(join(dir, 'inbox'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'processing'), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'history'), { recursive: true, mode: 0o700 });
    if (launchId) this.migrateLegacyLaunchAlias(launchId, id);
    const now = new Date();
    const previous = existed ? readJson<XjSession>(join(dir, 'session.json')) : undefined;
    if (previous?.launchId && launchId && previous.launchId !== launchId) throw new Error('invalid_launch_id');
    const clientKey = legacyClientKey || previous?.clientKey || launchId || id;
    const parentSessionId = input.parentSessionId
      ? safeSessionId(input.parentSessionId)
      : previous?.parentSessionId;
    if (parentSessionId && !existsSync(join(this.root, 'sessions', parentSessionId, 'session.json'))) {
      throw new Error('parent_session_not_found');
    }
    const terminalStatus = previous?.status === 'paused' || previous?.status === 'completed'
      ? previous.status
      : 'online';
    const session: XjSession = {
      id,
      clientKey,
      launchId: launchId || previous?.launchId,
      name: input.name?.trim() || previous?.name || input.title?.trim() || 'XJ Agent',
      role: input.role?.trim() || previous?.role,
      agentStatus: previous?.agentStatus,
      parentSessionId,
      agentSlot: input.agentSlot ?? previous?.agentSlot,
      title: input.title?.trim() || previous?.title || 'XJ Session',
      status: terminalStatus,
      createdAt: previous?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      reconnectUntil: new Date(now.getTime() + this.staleAfterMs).toISOString(),
      pendingCount: this.countInbox(id),
      modes: input.modes ? [...new Set(input.modes)] : previous?.modes ?? [],
    };
    atomicJson(join(dir, 'session.json'), session);
    if (!existsSync(join(dir, 'automation.json'))) {
      atomicJson(join(dir, 'automation.json'), createAutomation());
    }
    if (!existsSync(join(dir, 'progress.json'))) atomicJson(join(dir, 'progress.json'), EMPTY_PROGRESS);
    return { session, deduplicated: existed };
  }

  ensureSessionFamily(input: RegisterInput & { launchId: string }, subagentCount = 2): {
    session: XjSession;
    subagents: XjSession[];
    deduplicated: boolean;
  } {
    const main = this.register({ ...input, agentSlot: 'main', parentSessionId: undefined });
    const count = Math.max(0, Math.min(2, Math.trunc(subagentCount)));
    const subagents: XjSession[] = [];
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const child = this.register({
        launchId: childLaunchId(input.launchId, ordinal),
        name: `子 Agent ${ordinal}`,
        role: 'general-purpose',
        title: `${main.session.title} · 子 ${ordinal}`,
        modes: input.modes,
        parentSessionId: main.session.id,
        agentSlot: `subagent-${ordinal}` as XjAgentSlot,
      });
      subagents.push(child.session);
    }
    return { session: main.session, subagents, deduplicated: main.deduplicated };
  }

  listSubagents(parentSessionId: string): XjSession[] {
    const parent = this.getSession(parentSessionId);
    return this.listSessions()
      .filter((session) => session.parentSessionId === parent.id)
      .sort((a, b) => (a.agentSlot ?? '').localeCompare(b.agentSlot ?? ''));
  }

  listSessions(): XjSession[] {
    const root = join(this.root, 'sessions');
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSessionDir(entry.name))
      .flatMap((entry) => {
        try {
          return [this.getSession(entry.name)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(sessionId: string): XjSession {
    const id = safeSessionId(sessionId);
    const path = join(this.sessionDir(id), 'session.json');
    if (!existsSync(path)) throw new Error('session_not_found');
    let session = readJson<XjSession>(path);
    const mayBecomeOffline = ['connecting', 'online', 'waiting', 'working'].includes(session.status);
    if (mayBecomeOffline && Date.now() - new Date(session.lastSeenAt).getTime() > this.offlineAfterMs) {
      session = { ...session, status: 'offline', updatedAt: new Date().toISOString() };
      atomicJson(path, session);
    }
    return { ...session, pendingCount: this.countInbox(id) };
  }

  setStatus(sessionId: string, status: XjSessionStatus): XjSession {
    const session = this.getSession(sessionId);
    const now = new Date();
    const next: XjSession = {
      ...session,
      status,
      pendingCount: this.countInbox(session.id),
      updatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      reconnectUntil: new Date(now.getTime() + this.staleAfterMs).toISOString(),
    };
    atomicJson(join(this.sessionDir(session.id), 'session.json'), next);
    return next;
  }

  setModes(sessionId: string, modes: string[]): XjSession {
    const session = this.getSession(sessionId);
    const next = { ...session, modes: [...new Set(modes)], updatedAt: new Date().toISOString() };
    atomicJson(join(this.sessionDir(session.id), 'session.json'), next);
    return next;
  }

  setAgentMetadata(sessionId: string, input: { title?: string; agentStatus?: string }): XjSession {
    const session = this.getSession(sessionId);
    const now = new Date();
    const next: XjSession = {
      ...session,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(input.agentStatus?.trim() ? { agentStatus: input.agentStatus.trim() } : {}),
      updatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      reconnectUntil: new Date(now.getTime() + this.staleAfterMs).toISOString(),
    };
    atomicJson(join(this.sessionDir(session.id), 'session.json'), next);
    return next;
  }

  enqueueUserMessage(sessionId: string, content: string, metadata: Record<string, unknown> = {}): XjMessage {
    const session = this.getSession(sessionId);
    const clean = content.trim();
    if (!clean || clean.length > 1_000_000) throw new Error('invalid_message');
    const message = this.makeMessage(session.id, 'user', clean, metadata);
    atomicJson(join(this.sessionDir(session.id), 'inbox', `${message.id}.json`), message);
    this.persistHistory(message);
    this.setStatus(session.id, 'pending');
    return message;
  }

  dispatchSubagentTask(parentSessionId: string, subagentId: string, content: string, title?: string): XjMessage {
    const parent = this.getSession(parentSessionId);
    const child = this.getSession(subagentId);
    if (child.parentSessionId !== parent.id) throw new Error('subagent_not_linked');
    const clean = content.trim();
    if (!clean || clean.length > 1_000_000) throw new Error('invalid_message');
    const task = this.makeMessage(child.id, 'user', clean, {});
    task.metadata = {
      type: 'subagent_task',
      taskId: task.id,
      parentSessionId: parent.id,
      subagentId: child.id,
      title: title?.trim() || '协作任务',
    };
    atomicJson(join(this.sessionDir(child.id), 'inbox', `${task.id}.json`), task);
    this.persistHistory(task);
    this.setStatus(child.id, 'pending');
    return task;
  }

  async waitMessage(sessionId: string, options: WaitOptions = {}): Promise<WaitResult> {
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 300_000, 24 * 60 * 60 * 1000));
    const deadline = Date.now() + timeoutMs;
    const current = this.getSession(sessionId);
    const initialAutomation = this.getAutomation(sessionId);
    if (current.status === 'completed' || initialAutomation.state === 'done') {
      if (current.status !== 'completed') this.setStatus(sessionId, 'completed');
      return { kind: 'completed', continueWith: null };
    }
    if (current.status === 'paused' || initialAutomation.state === 'paused') {
      if (current.status !== 'paused') this.setStatus(sessionId, 'paused');
      return { kind: 'paused', continueWith: null };
    }
    this.setStatus(sessionId, 'waiting');
    let nextHeartbeatAt = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) {
        this.setStatus(sessionId, 'online');
        return { kind: 'aborted', continueWith: 'wait_message' };
      }
      const automation = this.getAutomation(sessionId);
      if (automation.state === 'paused') {
        this.setStatus(sessionId, 'paused');
        return { kind: 'paused', continueWith: null };
      }
      if (automation.state === 'done') {
        this.setStatus(sessionId, 'completed');
        return { kind: 'completed', continueWith: null };
      }
      this.requeueExpiredClaims(sessionId);
      const message = this.claimNextMessage(sessionId);
      if (message) {
        this.setStatus(sessionId, 'working');
        return { kind: 'message', message, continueWith: 'wait_message' };
      }
      if (Date.now() >= nextHeartbeatAt) {
        this.setStatus(sessionId, 'waiting');
        nextHeartbeatAt = Date.now() + 30_000;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    this.setStatus(sessionId, 'online');
    return { kind: 'timeout', continueWith: 'wait_message' };
  }

  reply(sessionId: string, content: string, metadata: Record<string, unknown> = {}): XjMessage & { continueWith: 'wait_message' | null } {
    const session = this.getSession(sessionId);
    const clean = content.trim();
    if (!clean) throw new Error('invalid_message');
    const message = this.makeMessage(session.id, 'assistant', clean, metadata);
    this.persistHistory(message);
    const claimed = this.readActiveClaim(session.id);
    this.acknowledgeClaim(session.id);
    const title = typeof metadata.title === 'string' ? metadata.title : undefined;
    const agentStatus = typeof metadata.agentStatus === 'string' ? metadata.agentStatus : undefined;
    const terminal = session.status === 'paused' || session.status === 'completed';
    this.setStatus(session.id, terminal ? session.status : 'online');
    if (title || agentStatus) this.setAgentMetadata(session.id, { title, agentStatus });
    if (
      session.parentSessionId
      && claimed?.metadata?.type === 'subagent_task'
      && claimed.metadata.parentSessionId === session.parentSessionId
    ) {
      const taskTitle = typeof claimed.metadata.title === 'string' ? claimed.metadata.title : '协作任务';
      this.enqueueUserMessage(
        session.parentSessionId,
        `[XJ_MSG · AGENT_RESULT]\n${session.name ?? session.id} · ${taskTitle}\n\n${clean}`,
        {
          type: 'subagent_result',
          taskId: claimed.id,
          taskTitle,
          subagentId: session.id,
          subagentName: session.name,
          evidence: metadata.evidence ?? [],
        },
      );
    }
    return { ...message, continueWith: terminal ? null : 'wait_message' };
  }

  reportProgress(sessionId: string, input: Partial<Omit<XjProgress, 'updatedAt'>>): XjProgress {
    const current = this.getProgress(sessionId);
    const progress: XjProgress = {
      percent: Math.max(0, Math.min(100, input.percent ?? current.percent)),
      summary: input.summary ?? current.summary,
      todo: input.todo ? [...input.todo] : current.todo,
      evidence: input.evidence ? [...input.evidence] : current.evidence,
      updatedAt: new Date().toISOString(),
    };
    atomicJson(join(this.sessionDir(sessionId), 'progress.json'), progress);
    const event = this.makeMessage(sessionId, 'progress', progress.summary || `Progress ${progress.percent}%`, { progress });
    this.persistHistory(event);
    this.refreshClaimLease(sessionId);
    return progress;
  }

  getProgress(sessionId: string): XjProgress {
    this.getSession(sessionId);
    const path = join(this.sessionDir(sessionId), 'progress.json');
    return existsSync(path) ? readJson<XjProgress>(path) : { ...EMPTY_PROGRESS };
  }

  getHistory(sessionId: string, limit = 500): XjMessage[] {
    this.getSession(sessionId);
    const dir = join(this.sessionDir(sessionId), 'history');
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .slice(-Math.max(1, Math.min(limit, 10_000)))
      .flatMap((name) => {
        try { return [readJson<XjMessage>(join(dir, name))]; } catch { return []; }
      });
  }

  getAutomation(sessionId: string): XjAutomation {
    this.getSession(sessionId);
    const path = join(this.sessionDir(sessionId), 'automation.json');
    return existsSync(path) ? readJson<XjAutomation>(path) : createAutomation();
  }

  setAutomation(sessionId: string, input: Partial<XjAutomation>): XjAutomation {
    const current = this.getAutomation(sessionId);
    if (
      current.state !== 'idle'
      && current.acceptanceCriteria.length > 0
      && input.acceptanceCriteria
      && JSON.stringify(input.acceptanceCriteria) !== JSON.stringify(current.acceptanceCriteria)
    ) {
      throw new Error('acceptance_criteria_frozen');
    }
    const defined = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Partial<XjAutomation>;
    const next = createAutomation({ ...current, ...defined, updatedAt: new Date().toISOString() });
    if (Object.hasOwn(input, 'pauseReason') && input.pauseReason === undefined) delete next.pauseReason;
    atomicJson(join(this.sessionDir(sessionId), 'automation.json'), next);
    if (next.state === 'paused') this.setStatus(sessionId, 'paused');
    if (next.state === 'done') this.setStatus(sessionId, 'completed');
    return next;
  }

  pause(sessionId: string): XjAutomation {
    return this.setAutomation(sessionId, { enabled: true, state: 'paused', pauseReason: 'user' });
  }

  resume(sessionId: string): XjAutomation {
    const automation = this.setAutomation(sessionId, { enabled: true, state: 'running', pauseReason: undefined });
    this.setStatus(sessionId, this.countInbox(sessionId) > 0 ? 'pending' : 'online');
    return automation;
  }

  completeSession(sessionId: string, input: { summary: string; evidence?: string[] }): {
    progress: XjProgress;
    automation: XjAutomation;
  } {
    const automation = this.getAutomation(sessionId);
    const reportedProgress = this.getProgress(sessionId);
    const completed = new Set(automation.completedCriteria);
    if (
      automation.todo.length > 0
      || reportedProgress.todo.length > 0
      || automation.acceptanceCriteria.some((criterion) => !completed.has(criterion))
    ) {
      throw new Error('completion_gates_not_met');
    }
    const progress = this.reportProgress(sessionId, {
      percent: 100,
      summary: input.summary,
      todo: [],
      evidence: input.evidence ?? [],
    });
    const done = this.setAutomation(sessionId, { enabled: false, state: 'done', todo: [] });
    this.setStatus(sessionId, 'completed');
    this.acknowledgeClaim(sessionId);
    return { progress, automation: done };
  }

  removeSession(sessionId: string): void {
    const id = safeSessionId(sessionId);
    for (const child of this.listSessions().filter((session) => session.parentSessionId === id)) {
      rmSync(this.sessionDir(child.id), { recursive: true, force: true });
      this.activeClaims.delete(child.id);
    }
    rmSync(this.sessionDir(id), { recursive: true, force: true });
    this.activeClaims.delete(id);
  }

  private sessionDir(sessionId: string): string {
    return join(this.root, 'sessions', safeSessionId(sessionId));
  }

  private countInbox(sessionId: string): number {
    const dir = join(this.root, 'sessions', sessionId, 'inbox');
    if (!existsSync(dir)) return 0;
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  }

  private claimNextMessage(sessionId: string): XjMessage | undefined {
    const inbox = join(this.sessionDir(sessionId), 'inbox');
    const processing = join(this.sessionDir(sessionId), 'processing');
    for (const name of readdirSync(inbox).filter((entry) => entry.endsWith('.json')).sort()) {
      const source = join(inbox, name);
      const target = join(processing, name);
      try {
        renameSync(source, target);
        const now = new Date();
        utimesSync(target, now, now);
        const message = readJson<XjMessage>(target);
        const claims = this.activeClaims.get(sessionId) ?? new Set<string>();
        claims.add(message.id);
        this.activeClaims.set(sessionId, claims);
        return message;
      } catch {
        // Another stdio client claimed this file first.
      }
    }
    return undefined;
  }

  private acknowledgeClaim(sessionId: string): void {
    const messageIds = this.activeClaims.get(sessionId);
    if (!messageIds) return;
    for (const messageId of messageIds) {
      rmSync(join(this.sessionDir(sessionId), 'processing', `${messageId}.json`), { force: true });
    }
    this.activeClaims.delete(sessionId);
  }

  private readActiveClaim(sessionId: string): XjMessage | undefined {
    const messageId = [...(this.activeClaims.get(sessionId) ?? [])].at(-1);
    if (!messageId) return undefined;
    const path = join(this.sessionDir(sessionId), 'processing', `${messageId}.json`);
    if (!existsSync(path)) return undefined;
    try { return readJson<XjMessage>(path); } catch { return undefined; }
  }

  private refreshClaimLease(sessionId: string): void {
    const messageIds = this.activeClaims.get(sessionId);
    if (!messageIds) return;
    const now = new Date();
    for (const messageId of messageIds) {
      const path = join(this.sessionDir(sessionId), 'processing', `${messageId}.json`);
      if (existsSync(path)) utimesSync(path, now, now);
    }
  }

  private requeueExpiredClaims(sessionId: string): void {
    const processing = join(this.sessionDir(sessionId), 'processing');
    const inbox = join(this.sessionDir(sessionId), 'inbox');
    const cutoff = Date.now() - this.claimTimeoutMs;
    for (const name of readdirSync(processing).filter((entry) => entry.endsWith('.json'))) {
      const source = join(processing, name);
      try {
        if (statSync(source).mtimeMs > cutoff) continue;
        renameSync(source, join(inbox, basename(name)));
      } catch {
        // Another MCP process refreshed, acknowledged, or requeued the claim.
      }
    }
  }

  private migrateLegacyLaunchAlias(launchId: string, canonicalId: string): void {
    const legacyId = legacySessionId(launchId);
    if (legacyId === canonicalId) return;
    const legacyDir = join(this.root, 'sessions', legacyId);
    if (!existsSync(join(legacyDir, 'session.json'))) return;
    const canonicalDir = join(this.root, 'sessions', canonicalId);
    for (const queue of ['history', 'inbox', 'processing'] as const) {
      const sourceDir = join(legacyDir, queue);
      const targetDir = join(canonicalDir, queue);
      mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      if (!existsSync(sourceDir)) continue;
      for (const name of readdirSync(sourceDir).filter((entry) => entry.endsWith('.json'))) {
        try {
          const source = readJson<XjMessage>(join(sourceDir, name));
          const target = join(targetDir, name);
          if (!existsSync(target)) atomicJson(target, { ...source, sessionId: canonicalId });
        } catch {
          // Leave malformed legacy files isolated; valid durable messages continue migrating.
        }
      }
    }
    for (const stateName of ['progress.json', 'automation.json'] as const) {
      const source = join(legacyDir, stateName);
      const target = join(canonicalDir, stateName);
      if (!existsSync(source)) continue;
      try {
        const sourceState = readJson<{ updatedAt?: string }>(source);
        const targetState = existsSync(target) ? readJson<{ updatedAt?: string }>(target) : undefined;
        const sourceTime = new Date(sourceState.updatedAt ?? 0).getTime();
        const targetTime = new Date(targetState?.updatedAt ?? 0).getTime();
        if (!targetState || sourceTime >= targetTime) atomicJson(target, sourceState);
      } catch {
        // Ignore malformed optional state; session/history migration remains intact.
      }
    }
    rmSync(legacyDir, { recursive: true, force: true });
    this.activeClaims.delete(legacyId);
  }

  private makeMessage(
    sessionId: string,
    role: XjMessage['role'],
    content: string,
    metadata: Record<string, unknown>,
  ): XjMessage {
    const createdAt = new Date().toISOString();
    this.lastMessageOrdinal = Math.max(Date.now(), this.lastMessageOrdinal + 1);
    const sortable = `${this.lastMessageOrdinal.toString().padStart(13, '0')}-${randomUUID()}`;
    return { id: sortable, sessionId, role, content, createdAt, metadata };
  }

  private persistHistory(message: XjMessage): void {
    const path = join(this.sessionDir(message.sessionId), 'history', `${message.id}.json`);
    if (!existsSync(path)) atomicJson(path, message);
  }
}
