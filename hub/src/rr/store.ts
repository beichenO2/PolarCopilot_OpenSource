import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { RrActiveTask, RrMessage, RrResumeContext, RrSession, RrSubagentView } from './types.js';
import { auditXjSource } from './xj-migration.js';

interface RrStoreOptions {
  offlineAfterMs?: number;
  taskStaleAfterMs?: number;
  resumeLeaseMs?: number;
}

interface RegisterInput {
  sessionId?: string;
  name: string;
  role?: string;
  launchId?: string;
}

interface ReplyMetadata {
  agentStatus?: string;
  suggestions?: string[];
  title?: string;
  visibility?: 'public' | 'internal';
}

const DEFAULT_OFFLINE_MS = 90_000;
const DEFAULT_TASK_STALE_MS = 30 * 60_000;
const DEFAULT_RESUME_LEASE_MS = 5 * 60_000;

interface RrResumeLease {
  sessionId: string;
  leaseId: string;
  ownerInstanceId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function safeSessionId(value: string): string {
  const rrOrImportedAgent = /^(?:rr|xj)-mcp-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const importedPending = /^xj-mcp-pending-\d+-[0-9a-f]{8}$/;
  if (!rrOrImportedAgent.test(value) && !importedPending.test(value)) throw new Error('invalid_session_id');
  return value;
}

function makeMessageId(): string {
  return `m-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export class RrFileStore {
  readonly root: string;
  private readonly offlineAfterMs: number;
  private readonly taskStaleAfterMs: number;
  private readonly resumeLeaseMs: number;

  constructor(root: string, options: RrStoreOptions = {}) {
    this.root = root;
    this.offlineAfterMs = options.offlineAfterMs ?? DEFAULT_OFFLINE_MS;
    this.taskStaleAfterMs = options.taskStaleAfterMs ?? DEFAULT_TASK_STALE_MS;
    this.resumeLeaseMs = options.resumeLeaseMs ?? DEFAULT_RESUME_LEASE_MS;
    for (const dir of ['sessions', 'history', 'inbox', 'processing', 'subagents', 'tasks', 'task-locks', 'resume-leases']) {
      mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    }
  }

  register(input: RegisterInput, ownerInstanceId?: string): { session: RrSession; deduplicated: boolean; resume?: RrResumeContext } {
    const name = input.name.trim();
    if (!name) throw new Error('invalid_name');
    if (!input.sessionId && !input.launchId && name.toLowerCase() === 'continue') {
      if (!ownerInstanceId) throw new Error('resume_owner_required');
      const resume = this.resumeLatestImportedSession(ownerInstanceId);
      return { session: resume.session, deduplicated: true, resume };
    }
    const existing = input.sessionId
      ? this.getSession(input.sessionId)
      : input.launchId
        ? this.listSessionsRaw().find((session) => session.launchId === input.launchId)
        : undefined;
    const now = Date.now();
    if (existing) {
      if (input.launchId && existing.launchId && input.launchId !== existing.launchId) throw new Error('invalid_launch_id');
      const next = this.saveSession({
        ...existing,
        name,
        role: input.role ?? existing.role,
        launchId: input.launchId ?? existing.launchId,
        lastActiveAt: now,
        online: true,
        status: existing.activeTask ? 'working' : 'online',
      });
      return { session: next, deduplicated: true };
    }
    const sessionId = `rr-mcp-agent-${randomUUID()}`;
    const session: RrSession = {
      sessionId,
      name,
      ...(input.role ? { role: input.role } : {}),
      ...(input.launchId ? { launchId: input.launchId } : {}),
      title: name,
      createdAt: now,
      lastActiveAt: now,
      agentStatus: 'ready',
      waiting: false,
      pendingMessages: 0,
      online: true,
      isSubagent: false,
      uiLocale: 'zh-cn',
      lastMessageTs: 0,
      status: 'online',
    };
    this.saveSession(session);
    return { session, deduplicated: false };
  }

  getSession(sessionId: string): RrSession {
    const path = this.sessionPath(sessionId);
    if (!existsSync(path)) throw new Error('session_not_found');
    const session = readJson<RrSession>(path);
    return this.withRuntimeState(session);
  }

  listSessions(): RrSession[] {
    this.recoverStaleTasks();
    return this.listSessionsRaw()
      .map((session) => this.withRuntimeState(session))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  resumeLatestImportedSession(ownerInstanceId: string): RrResumeContext {
    const candidates = this.listSessionsRaw().filter((session) =>
      session.sessionId.startsWith('xj-mcp-agent-')
      && session.compat?.source === 'xj'
      && session.compat.raw.sessionId === session.sessionId);
    candidates.sort((a, b) => {
      const aSourceActive = Number(a.compat?.raw.lastActiveAt ?? 0);
      const bSourceActive = Number(b.compat?.raw.lastActiveAt ?? 0);
      return (bSourceActive - aSourceActive) || a.sessionId.localeCompare(b.sessionId);
    });
    const selected = candidates[0];
    if (!selected?.compat) throw new Error('no_imported_session');
    this.acquireResumeLease(selected.sessionId, ownerInstanceId);
    const session = this.saveSession({
      ...selected,
      lastActiveAt: Date.now(),
      online: true,
      waiting: false,
      status: selected.activeTask ? 'working' : 'online',
    });
    const tasks = readdirSync(join(this.root, 'tasks')).filter((name) => name.endsWith('.json')).sort().flatMap((name) => {
      try {
        const task = readJson<Record<string, unknown>>(join(this.root, 'tasks', name));
        if (task.masterSessionId !== session.sessionId && task.targetSessionId !== session.sessionId) return [];
        const compat = task.compat;
        if (compat && typeof compat === 'object' && !Array.isArray(compat) && (compat as Record<string, unknown>).source === 'xj') {
          const raw = (compat as Record<string, unknown>).raw;
          return raw && typeof raw === 'object' && !Array.isArray(raw) ? [raw as Record<string, unknown>] : [task];
        }
        return [task];
      } catch {
        return [];
      }
    });
    const workspacePath = join(this.root, 'compat', 'xj', 'raw', 'session-workspace.json');
    let workspace: Record<string, unknown> | undefined;
    if (existsSync(workspacePath)) {
      try {
        const workspaceMap = readJson<Record<string, unknown>>(workspacePath);
        const entry = workspaceMap[session.sessionId];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) workspace = entry as Record<string, unknown>;
      } catch {
        // The immutable raw tree is verified separately; resume can proceed without the optional workspace map.
      }
    }
    const rawRoot = join(this.root, 'compat', 'xj', 'raw');
    const topology = auditXjSource(rawRoot).topology as unknown as Record<string, unknown>;
    return {
      session,
      sourceSession: selected.compat.raw,
      sourceLastActiveAt: Number(selected.compat.raw.lastActiveAt ?? 0),
      history: this.getHistory(session.sessionId, Number.MAX_SAFE_INTEGER),
      tasks,
      ...(workspace ? { workspace } : {}),
      topology,
    };
  }

  setSubagent(sessionId: string, enabled: boolean): RrSession {
    const session = this.getSession(sessionId);
    const next = this.saveSession({ ...session, isSubagent: enabled, lastActiveAt: Date.now() });
    atomicJson(join(this.root, 'subagents', `${sessionId}.json`), {
      sessionId,
      enabled,
      updatedAt: Date.now(),
    });
    return next;
  }

  updateSession(sessionId: string, patch: { title?: string; agentStatus?: string }, ownerInstanceId?: string): RrSession {
    if (ownerInstanceId !== undefined) this.assertResumeOwner(sessionId, ownerInstanceId);
    const session = this.getSession(sessionId);
    return this.saveSession({
      ...session,
      ...(patch.title !== undefined ? { title: patch.title.slice(0, 40) } : {}),
      ...(patch.agentStatus !== undefined ? { agentStatus: patch.agentStatus } : {}),
      lastActiveAt: Date.now(),
      online: true,
    });
  }

  enqueueUserMessage(sessionId: string, content: string, metadata: Record<string, unknown> = {}): RrMessage {
    const session = this.getSession(sessionId);
    const clean = content.trim();
    if (!clean) throw new Error('invalid_message');
    const message = this.makeMessage(sessionId, 'user', 'panel', sessionId, clean, {
      type: 'user_task',
      ...metadata,
    });
    this.persistHistory(message);
    this.enqueue(message);
    this.saveSession({ ...session, pendingMessages: this.pendingCount(sessionId), lastMessageTs: message.createdAt });
    return message;
  }

  reply(sessionId: string, content: string, metadata: ReplyMetadata = {}, ownerInstanceId?: string): RrMessage {
    const resumeLease = this.assertResumeOwner(sessionId, ownerInstanceId);
    const session = this.getSession(sessionId);
    const clean = content.trim();
    if (!clean) throw new Error('invalid_message');
    const message = this.makeMessage(sessionId, 'assistant', sessionId, 'panel', clean, { ...metadata });
    if (metadata.visibility !== 'internal') this.persistHistory(message);
    this.acknowledgeOne(sessionId, (claim) => claim.metadata?.type !== 'subagent_task', resumeLease?.leaseId);
    this.saveSession({
      ...session,
      title: metadata.title?.slice(0, 40) ?? session.title,
      agentStatus: metadata.agentStatus ?? session.agentStatus,
      lastActiveAt: Date.now(),
      lastMessageTs: message.createdAt,
      online: true,
      waiting: false,
      status: session.activeTask ? 'working' : 'online',
      pendingMessages: this.pendingCount(sessionId),
    });
    return message;
  }

  async waitMessage(sessionId: string, timeoutMs: number, signal?: AbortSignal, ownerInstanceId?: string): Promise<RrMessage | undefined> {
    let resumeLease = this.assertResumeOwner(sessionId, ownerInstanceId);
    const timeout = Math.max(10_000, Math.min(600_000, timeoutMs));
    const deadline = Date.now() + timeout;
    let delivered = false;
    this.touchWaiting(sessionId, true);
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) return undefined;
        // Ownership must be checked immediately before every claim. A process can
        // be paused beyond the lease deadline while another MCP instance takes over.
        resumeLease = this.assertResumeOwner(sessionId, ownerInstanceId);
        this.recoverStaleTasks();
        const message = this.claimNext(sessionId, resumeLease?.leaseId);
        if (message) {
          delivered = true;
          const session = this.getSession(sessionId);
          this.saveSession({
            ...session,
            waiting: false,
            status: 'working',
            pendingMessages: this.pendingCount(sessionId),
            lastActiveAt: Date.now(),
            online: true,
          });
          return message;
        }
        this.touchWaiting(sessionId, true);
        const leasePollMs = resumeLease ? Math.max(1, Math.floor(this.resumeLeaseMs / 3)) : 100;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, leasePollMs, Math.max(1, deadline - Date.now()))));
      }
      return undefined;
    } finally {
      let stillOwner = true;
      try { this.assertResumeOwner(sessionId, ownerInstanceId); }
      catch { stillOwner = false; }
      if (stillOwner) {
        const session = this.getSession(sessionId);
        this.saveSession({
          ...session,
          waiting: false,
          status: delivered || session.activeTask ? 'working' : 'online',
          lastActiveAt: Date.now(),
          online: true,
        });
      }
    }
  }

  claimAvailableMessageForOwner(sessionId: string, ownerInstanceId: string): RrMessage | undefined {
    const resumeLease = this.assertResumeOwner(sessionId, ownerInstanceId);
    return this.claimNext(sessionId, resumeLease?.leaseId);
  }

  getHistory(sessionId: string, limit = 500): RrMessage[] {
    this.getSession(sessionId);
    const path = join(this.root, 'history', `${sessionId}.jsonl`);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-limit).flatMap((line) => {
      try { return [JSON.parse(line) as RrMessage]; } catch { return []; }
    });
  }

  listSubagents(callerSessionId?: string): RrSubagentView[] {
    this.recoverStaleTasks();
    return this.listSessionsRaw()
      .filter((session) => session.isSubagent && session.sessionId !== callerSessionId)
      .map((session) => {
        const activeTask = this.readTaskLock(session.sessionId);
        const offline = Date.now() - session.lastActiveAt > this.offlineAfterMs;
        return {
          sessionId: session.sessionId,
          name: session.name,
          availability: offline ? 'offline' as const : activeTask ? 'busy' as const : 'idle' as const,
          agentStatus: session.agentStatus,
          lastActiveAt: session.lastActiveAt,
          ...(activeTask ? { activeTask } : {}),
        };
      });
  }

  dispatchSubagentTask(masterSessionId: string, targetSessionId: string, content: string): RrActiveTask {
    const master = this.getSession(masterSessionId);
    const target = this.getSession(targetSessionId);
    if (master.sessionId === target.sessionId) throw new Error('invalid_target_session');
    if (!target.isSubagent) throw new Error('target_not_subagent');
    if (Date.now() - target.lastActiveAt > this.offlineAfterMs) throw new Error('target_offline');
    const clean = content.trim();
    if (!clean) throw new Error('invalid_task_content');
    const now = Date.now();
    const task: RrActiveTask = {
      taskId: `rr-task-${randomUUID()}`,
      masterSessionId,
      targetSessionId,
      content: clean,
      createdAt: now,
      updatedAt: now,
    };
    const lockPath = this.taskLockPath(targetSessionId);
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(fd, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    } catch (error) {
      throw Object.assign(new Error('target_busy'), { cause: error });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    try {
      atomicJson(join(this.root, 'tasks', `${task.taskId}.json`), { ...task, status: 'active' });
      const message = this.makeMessage(
        targetSessionId,
        'user',
        masterSessionId,
        targetSessionId,
        clean,
        { type: 'subagent_task', taskId: task.taskId, masterSessionId },
      );
      this.persistHistory(message);
      this.enqueue(message);
      this.saveSession({
        ...target,
        activeTask: task,
        pendingMessages: this.pendingCount(targetSessionId),
        status: 'working',
      });
      return task;
    } catch (error) {
      rmSync(lockPath, { force: true });
      throw error;
    }
  }

  reportTaskProgress(sessionId: string, taskId: string, progress: string, percent?: number): RrActiveTask {
    const task = this.requireActiveTask(sessionId, taskId);
    const next: RrActiveTask = {
      ...task,
      updatedAt: Date.now(),
      progress: {
        text: progress.trim(),
        ...(percent === undefined ? {} : { percent: Math.max(0, Math.min(100, percent)) }),
        updatedAt: Date.now(),
      },
    };
    atomicJson(this.taskLockPath(sessionId), next);
    atomicJson(join(this.root, 'tasks', `${taskId}.json`), { ...next, status: 'active' });
    const session = this.getSession(sessionId);
    this.saveSession({ ...session, activeTask: next, lastActiveAt: Date.now(), online: true, status: 'working' });
    return next;
  }

  completeSubagentTask(sessionId: string, taskId: string, result: string, ok = true): RrActiveTask {
    const task = this.requireActiveTask(sessionId, taskId);
    const clean = result.trim();
    if (!clean) throw new Error('invalid_task_result');
    const resultMessage = this.makeMessage(
      task.masterSessionId,
      'user',
      sessionId,
      task.masterSessionId,
      clean,
      { type: 'subagent_result', taskId, subagentSessionId: sessionId, ok },
    );
    this.persistHistory(resultMessage);
    this.enqueue(resultMessage);
    atomicJson(join(this.root, 'tasks', `${taskId}.json`), {
      ...task,
      status: ok ? 'completed' : 'failed',
      result: clean,
      completedAt: Date.now(),
      resultDelivered: true,
    });
    this.acknowledgeOne(sessionId, (claim) => claim.metadata?.taskId === taskId);
    rmSync(this.taskLockPath(sessionId), { force: true });
    const session = this.getSession(sessionId);
    const { activeTask: _activeTask, ...withoutTask } = session;
    this.saveSession({
      ...withoutTask,
      lastActiveAt: Date.now(),
      online: true,
      status: 'online',
      agentStatus: ok ? 'task_complete' : 'task_failed',
      pendingMessages: this.pendingCount(sessionId),
    });
    return task;
  }

  recoverStaleTasks(): number {
    let recovered = 0;
    const cutoff = Date.now() - this.taskStaleAfterMs;
    for (const name of readdirSync(join(this.root, 'task-locks')).filter((entry) => entry.endsWith('.json'))) {
      const path = join(this.root, 'task-locks', name);
      try {
        const task = readJson<RrActiveTask>(path);
        if (task.updatedAt > cutoff && statSync(path).mtimeMs > cutoff) continue;
        const message = this.makeMessage(
          task.masterSessionId,
          'system',
          'rr-recovery',
          task.masterSessionId,
          `子 Agent ${task.targetSessionId} 的任务 ${task.taskId} 心跳过期，Rr 已释放 busy 锁。`,
          { type: 'subagent_result', taskId: task.taskId, subagentSessionId: task.targetSessionId, ok: false, recovered: true },
        );
        this.persistHistory(message);
        this.enqueue(message);
        atomicJson(join(this.root, 'tasks', `${task.taskId}.json`), { ...task, status: 'stale', completedAt: Date.now() });
        this.acknowledgeOne(task.targetSessionId, (claim) => claim.metadata?.taskId === task.taskId);
        rmSync(path, { force: true });
        const session = this.getSession(task.targetSessionId);
        const { activeTask: _activeTask, ...withoutTask } = session;
        this.saveSession({ ...withoutTask, status: 'offline', online: false });
        recovered += 1;
      } catch {
        // A concurrent process completed or recovered the task first.
      }
    }
    return recovered + this.recoverStaleClaims();
  }

  removeSession(sessionId: string): void {
    const id = safeSessionId(sessionId);
    rmSync(this.sessionPath(id), { force: true });
    rmSync(join(this.root, 'history', `${id}.jsonl`), { force: true });
    rmSync(join(this.root, 'inbox', id), { recursive: true, force: true });
    rmSync(join(this.root, 'processing', id), { recursive: true, force: true });
    rmSync(join(this.root, 'subagents', `${id}.json`), { force: true });
    rmSync(this.taskLockPath(id), { force: true });
    rmSync(this.resumeLeasePath(id), { force: true });
  }

  teamCounts(): { online: number; waiting: number; pending: number } {
    const sessions = this.listSessions();
    return {
      online: sessions.filter((session) => session.online).length,
      waiting: sessions.filter((session) => session.waiting).length,
      pending: sessions.reduce((sum, session) => sum + session.pendingMessages, 0),
    };
  }

  private listSessionsRaw(): RrSession[] {
    return readdirSync(join(this.root, 'sessions'))
      .filter((name) => name.endsWith('.json'))
      .flatMap((name) => {
        try { return [readJson<RrSession>(join(this.root, 'sessions', name))]; } catch { return []; }
      });
  }

  private withRuntimeState(session: RrSession): RrSession {
    const activeTask = this.readTaskLock(session.sessionId);
    const online = Date.now() - session.lastActiveAt <= this.offlineAfterMs;
    const { activeTask: _persistedTask, ...base } = session;
    return {
      ...base,
      online,
      status: online ? activeTask ? 'working' : session.waiting ? 'waiting' : 'online' : 'offline',
      pendingMessages: this.pendingCount(session.sessionId),
      ...(activeTask ? { activeTask } : {}),
    };
  }

  private saveSession(session: RrSession): RrSession {
    atomicJson(this.sessionPath(session.sessionId), session);
    return session;
  }

  private sessionPath(sessionId: string): string {
    return join(this.root, 'sessions', `${safeSessionId(sessionId)}.json`);
  }

  private taskLockPath(sessionId: string): string {
    return join(this.root, 'task-locks', `${safeSessionId(sessionId)}.json`);
  }

  private readTaskLock(sessionId: string): RrActiveTask | undefined {
    const path = this.taskLockPath(sessionId);
    if (!existsSync(path)) return undefined;
    try { return readJson<RrActiveTask>(path); } catch { return undefined; }
  }

  private requireActiveTask(sessionId: string, taskId: string): RrActiveTask {
    const task = this.readTaskLock(sessionId);
    if (!task) throw new Error('task_not_active');
    if (task.taskId !== taskId) throw new Error('task_id_mismatch');
    return task;
  }

  private inboxDir(sessionId: string): string {
    const dir = join(this.root, 'inbox', safeSessionId(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private processingDir(sessionId: string): string {
    const dir = join(this.root, 'processing', safeSessionId(sessionId));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private pendingCount(sessionId: string): number {
    return readdirSync(this.inboxDir(sessionId)).filter((name) => name.endsWith('.json')).length;
  }

  private enqueue(message: RrMessage): void {
    atomicJson(join(this.inboxDir(message.sessionId), `${message.createdAt}-${message.msgId}.json`), message);
  }

  private claimNext(sessionId: string, leaseId?: string): RrMessage | undefined {
    const inbox = this.inboxDir(sessionId);
    const processing = this.processingDir(sessionId);
    if (readdirSync(processing).some((entry) => entry.endsWith('.json'))) return undefined;
    for (const name of readdirSync(inbox).filter((entry) => entry.endsWith('.json')).sort()) {
      try {
        const source = join(inbox, name);
        const target = join(processing, name);
        renameSync(source, target);
        const message = readJson<RrMessage>(target);
        if (leaseId) {
          message.metadata = { ...message.metadata, rrClaim: { leaseId } };
          atomicJson(target, message);
        }
        return message;
      } catch {
        // Another local stdio client won the atomic rename.
      }
    }
    return undefined;
  }

  private recoverStaleClaims(): number {
    const cutoff = Date.now() - this.taskStaleAfterMs;
    let recovered = 0;
    for (const sessionId of readdirSync(join(this.root, 'processing'))) {
      let processing: string;
      let inbox: string;
      try {
        processing = this.processingDir(sessionId);
        inbox = this.inboxDir(sessionId);
      } catch {
        continue;
      }
      for (const name of readdirSync(processing).filter((entry) => entry.endsWith('.json'))) {
        const source = join(processing, name);
        try {
          if (statSync(source).mtimeMs > cutoff) continue;
          const message = readJson<RrMessage>(source);
          if (message.metadata?.type === 'subagent_task' && this.readTaskLock(sessionId)) continue;
          renameSync(source, join(inbox, basename(source)));
          recovered += 1;
        } catch {
          // Another process acknowledged or recovered the claim first.
        }
      }
    }
    return recovered;
  }

  private acknowledgeOne(sessionId: string, predicate: (message: RrMessage) => boolean, leaseId?: string): void {
    const processing = this.processingDir(sessionId);
    for (const name of readdirSync(processing).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(processing, name);
      try {
        const message = readJson<RrMessage>(path);
        if (leaseId) {
          const claim = message.metadata?.rrClaim;
          if (!claim || typeof claim !== 'object' || Array.isArray(claim) || (claim as Record<string, unknown>).leaseId !== leaseId) continue;
        }
        if (!predicate(message)) continue;
        rmSync(path, { force: true });
        return;
      } catch {
        // Ignore malformed or concurrently removed claims.
      }
    }
  }

  private touchWaiting(sessionId: string, waiting: boolean): void {
    const session = this.getSession(sessionId);
    this.saveSession({
      ...session,
      waiting,
      online: true,
      status: waiting ? 'waiting' : session.activeTask ? 'working' : 'online',
      lastActiveAt: Date.now(),
    });
  }

  private resumeLeasePath(sessionId: string): string {
    return join(this.root, 'resume-leases', `${safeSessionId(sessionId)}.json`);
  }

  private acquireResumeLease(sessionId: string, ownerInstanceId: string): RrResumeLease {
    if (!ownerInstanceId) throw new Error('resume_owner_required');
    const path = this.resumeLeasePath(sessionId);
    const lockPath = `${path}.lock`;
    let lock: number | undefined;
    try {
      lock = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      throw Object.assign(new Error('resume_session_busy'), { cause: error });
    }
    try {
      const now = Date.now();
      let current: RrResumeLease | undefined;
      if (existsSync(path)) {
        try { current = readJson<RrResumeLease>(path); } catch { throw new Error('invalid_resume_lease'); }
      }
      if (current && current.expiresAt > now && current.ownerInstanceId !== ownerInstanceId) {
        throw new Error('resume_session_busy');
      }
      if (current && current.expiresAt <= now && current.ownerInstanceId !== ownerInstanceId) {
        this.redeliverExpiredResumeClaims(sessionId, current.leaseId);
      }
      const next: RrResumeLease = current?.ownerInstanceId === ownerInstanceId
        ? { ...current, heartbeatAt: now, expiresAt: now + this.resumeLeaseMs }
        : {
            sessionId,
            leaseId: randomUUID(),
            ownerInstanceId,
            acquiredAt: now,
            heartbeatAt: now,
            expiresAt: now + this.resumeLeaseMs,
          };
      atomicJson(path, next);
      return next;
    } finally {
      if (lock !== undefined) closeSync(lock);
      rmSync(lockPath, { force: true });
    }
  }

  private assertResumeOwner(sessionId: string, ownerInstanceId?: string): RrResumeLease | undefined {
    const sessionPath = this.sessionPath(sessionId);
    if (!existsSync(sessionPath)) throw new Error('session_not_found');
    const session = readJson<RrSession>(sessionPath);
    if (session.compat?.source !== 'xj') return undefined;
    if (!ownerInstanceId) throw new Error('resume_owner_required');
    const leasePath = this.resumeLeasePath(sessionId);
    if (!existsSync(leasePath)) throw new Error('resume_session_not_leased');
    const lease = readJson<RrResumeLease>(leasePath);
    const now = Date.now();
    if (lease.ownerInstanceId !== ownerInstanceId) throw new Error('resume_session_not_owner');
    if (lease.expiresAt <= now) throw new Error('resume_session_lease_expired');
    const refreshed = { ...lease, heartbeatAt: now, expiresAt: now + this.resumeLeaseMs };
    atomicJson(leasePath, refreshed);
    return refreshed;
  }

  private redeliverExpiredResumeClaims(sessionId: string, leaseId: string): void {
    const processing = this.processingDir(sessionId);
    const inbox = this.inboxDir(sessionId);
    for (const name of readdirSync(processing).filter((entry) => entry.endsWith('.json')).sort()) {
      const source = join(processing, name);
      const target = join(inbox, name);
      const message = readJson<RrMessage>(source);
      const claim = message.metadata?.rrClaim;
      const claimLeaseId = claim && typeof claim === 'object' && !Array.isArray(claim)
        ? (claim as Record<string, unknown>).leaseId
        : undefined;
      if (claimLeaseId !== undefined && claimLeaseId !== leaseId) continue;
      if (message.metadata) {
        const { rrClaim: _claim, ...metadata } = message.metadata;
        message.metadata = metadata;
      }
      renameSync(source, target);
      atomicJson(target, message);
    }
  }

  private makeMessage(
    sessionId: string,
    role: RrMessage['role'],
    from: string,
    to: string,
    content: string,
    metadata: Record<string, unknown>,
  ): RrMessage {
    return { msgId: makeMessageId(), sessionId, from, to, role, content, createdAt: Date.now(), metadata };
  }

  private persistHistory(message: RrMessage): void {
    const path = join(this.root, 'history', `${safeSessionId(message.sessionId)}.jsonl`);
    writeFileSync(path, `${JSON.stringify(message)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
}
