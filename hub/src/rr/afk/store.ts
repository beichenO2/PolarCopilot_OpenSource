import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  afkRoot,
  eventsPath,
  indexLockPath,
  indexPath,
  legacyAfkRoot,
  lockPath,
  resolveActiveTasks,
  statePath,
  summaryPath,
  taskDir,
  tasksRoot,
  TASK_ID_PATTERN,
} from './paths.js';
import type {
  InitTaskArtifactsInput,
  RrAfkEvent,
  RrAfkState,
  RrAfkSummary,
  RrAfkTaskIndex,
} from './types.js';

const DEFAULT_MAX_LOOPS = 40;
const INDEX_LOCK_TIMEOUT_MS = 5_000;
const INDEX_LOCK_RETRY_MS = 5;

let indexLockDepth = 0;
let indexLockFd: number | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function acquireIndexLock(): void {
  if (indexLockDepth > 0) {
    indexLockDepth += 1;
    return;
  }
  ensureAfkRoot();
  mkdirSync(tasksRoot(), { recursive: true, mode: 0o700 });
  const path = indexLockPath();
  const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, `${process.pid}\n`, 'utf8');
      indexLockFd = fd;
      indexLockDepth = 1;
      return;
    } catch {
      const waitUntil = Date.now() + INDEX_LOCK_RETRY_MS;
      while (Date.now() < waitUntil) {
        // brief spin while another writer holds .index.lock
      }
    }
  }
  throw new Error('index_lock_timeout');
}

function releaseIndexLock(): void {
  if (indexLockDepth <= 0) return;
  indexLockDepth -= 1;
  if (indexLockDepth > 0) return;
  if (indexLockFd !== null) {
    closeSync(indexLockFd);
    indexLockFd = null;
  }
  rmSync(indexLockPath(), { force: true });
}

export function withIndexLock<T>(fn: () => T): T {
  acquireIndexLock();
  try {
    return fn();
  } finally {
    releaseIndexLock();
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function defaultPlan(taskId: string): string {
  return `# AFK Plan · ${taskId}\n\n## Goal\n\n<!-- One-line outcome -->\n\n## Units\n\n1. U1 — first atomic unit\n`;
}

function defaultCriteria(): string {
  // vNext: do NOT seed fake `npm test` / U1 — agent must freeze real criteria before DONE.
  return '# Acceptance Criteria\n\n<!-- afk:criteria-unfrozen -->\n<!-- Freeze real, project-specific criteria before VERIFYING/DONE. -->\n';
}

function defaultTasks(): string {
  return '# Task Units\n\n<!-- Add atomic units after plan freeze; do not invent placeholder U1. -->\n';
}

function defaultTodo(): string {
  return '# TODO\n\n<!-- Open items use `- [ ]`; empty checklist means no open work. -->\n';
}

function defaultDecisions(): string {
  return '# Decisions Log\n\n<!-- Record non-obvious choices during AFK -->\n';
}

export function ensureAfkRoot(): string {
  const root = afkRoot();
  mkdirSync(join(root, 'tasks'), { recursive: true, mode: 0o700 });
  return root;
}

function filterTaskIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return ids.filter((taskId): taskId is string => typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId));
}

function readIndexUnlocked(): RrAfkTaskIndex {
  ensureAfkRoot();
  const path = indexPath();
  if (!existsSync(path)) {
    return { active_tasks: [], done_tasks: [], updated_at: nowIso() };
  }
  try {
    const raw = readJson<Partial<RrAfkTaskIndex>>(path);
    return {
      active_tasks: filterTaskIds(raw.active_tasks),
      done_tasks: filterTaskIds(raw.done_tasks),
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
    };
  } catch {
    return { active_tasks: [], done_tasks: [], updated_at: nowIso() };
  }
}

function writeIndexUnlocked(index: RrAfkTaskIndex): RrAfkTaskIndex {
  ensureAfkRoot();
  const path = indexPath();
  let preservedDone: string[] = [];
  if (index.done_tasks === undefined && existsSync(path)) {
    try {
      preservedDone = filterTaskIds(readJson<Partial<RrAfkTaskIndex>>(path).done_tasks);
    } catch {
      preservedDone = [];
    }
  }
  const next: RrAfkTaskIndex = {
    active_tasks: [...new Set(filterTaskIds(index.active_tasks))],
    done_tasks: [...new Set(filterTaskIds(index.done_tasks ?? preservedDone))],
    updated_at: index.updated_at || nowIso(),
  };
  atomicJson(path, next);
  return next;
}

export function readIndex(): RrAfkTaskIndex {
  return withIndexLock(readIndexUnlocked);
}

export function writeIndex(index: RrAfkTaskIndex): RrAfkTaskIndex {
  return withIndexLock(() => writeIndexUnlocked(index));
}

function appendTaskDone(taskId: string): RrAfkTaskIndex {
  return withIndexLock(() => {
    const index = readIndexUnlocked();
    const active_tasks = index.active_tasks.filter((id) => id !== taskId);
    const done_tasks = [...new Set([...(index.done_tasks ?? []), taskId])];
    return writeIndexUnlocked({ active_tasks, done_tasks, updated_at: nowIso() });
  });
}

/**
 * Mark task DONE in state.json and move taskId from active_tasks → done_tasks.
 * Idempotent index repair: if already DONE, still ensure index membership is correct
 * (fixes legacy early-return that left DONE ids in active_tasks).
 * Callers that expose DONE to users must go through completion gate first (doneAfk).
 */
export function markTaskDone(taskId: string): RrAfkState | null {
  const state = readState(taskId);
  if (!state) return null;
  if (state.status === 'DONE') {
    appendTaskDone(taskId);
    return readState(taskId);
  }
  const timestamp = nowIso();
  const next = writeState(taskId, { ...state, status: 'DONE', updated_at: timestamp });
  return next;
}

function summaryFromState(state: RrAfkState): RrAfkSummary {
  return {
    task_id: state.task_id,
    status: state.status,
    master_session_id: state.master_session_id,
    current_unit: state.current_unit,
    plan_revision: state.plan_revision,
    loop: state.loop,
    allowlist: Array.isArray(state.allowlist) ? [...state.allowlist] : [],
    permission_request: state.permission_request,
    last_command: state.last_command,
    last_verification: state.last_verification,
    human_action_hint: state.human_action_hint,
    updated_at: state.updated_at,
    heartbeat: state.heartbeat ? { ...state.heartbeat } : undefined,
    project_root: state.project_root,
    mode: state.mode,
    ...(typeof state.allow_new_subagents === 'boolean'
      ? { allow_new_subagents: state.allow_new_subagents }
      : {}),
  };
}

export function readState(taskId: string): RrAfkState | null {
  const path = statePath(taskId);
  if (!existsSync(path)) return null;
  try {
    return readJson<RrAfkState>(path);
  } catch {
    return null;
  }
}

export function writeState(taskId: string, state: RrAfkState): RrAfkState {
  ensureAfkRoot();
  mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 });
  const prev = readState(taskId);
  const next = { ...state, task_id: taskId, updated_at: state.updated_at || nowIso() };
  atomicJson(statePath(taskId), next);
  writeSummary(taskId, summaryFromState(next));
  if (next.status === 'DONE' && prev?.status !== 'DONE') {
    appendTaskDone(taskId);
    appendEvent(taskId, { kind: 'task_done', detail: { previousStatus: prev?.status ?? null } });
  }
  return next;
}

export function readSummary(taskId: string): RrAfkSummary | null {
  const path = summaryPath(taskId);
  if (!existsSync(path)) {
    const state = readState(taskId);
    return state ? summaryFromState(state) : null;
  }
  try {
    const raw = readJson<RrAfkSummary>(path);
    if (!raw.updated_at) {
      const state = readState(taskId);
      raw.updated_at = state?.updated_at ?? nowIso();
    }
    return raw;
  } catch {
    return null;
  }
}

export function writeSummary(taskId: string, summary: RrAfkSummary): RrAfkSummary {
  ensureAfkRoot();
  mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 });
  const next = { ...summary, task_id: taskId, updated_at: summary.updated_at || nowIso() };
  atomicJson(summaryPath(taskId), next);
  return next;
}

export function appendEvent(taskId: string, event: RrAfkEvent): void {
  ensureAfkRoot();
  mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 });
  appendFileSync(eventsPath(taskId), `${JSON.stringify({ ...event, at: event.at || nowIso() })}\n`, 'utf8');
}

export function acquireTaskLock(taskId: string): boolean {
  ensureAfkRoot();
  mkdirSync(taskDir(taskId), { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(lockPath(taskId), 'wx', 0o600);
    writeFileSync(fd, `${process.pid}\n`, 'utf8');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function releaseTaskLock(taskId: string): void {
  rmSync(lockPath(taskId), { force: true });
}

function listTaskIds(): string[] {
  ensureAfkRoot();
  const root = tasksRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function listTaskSummaries(): RrAfkSummary[] {
  const summaries: RrAfkSummary[] = [];
  for (const taskId of listTaskIds()) {
    const summary = readSummary(taskId);
    if (summary) summaries.push(summary);
  }
  summaries.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  return summaries;
}

export function setTaskActive(taskId: string, active: boolean): RrAfkTaskIndex {
  return withIndexLock(() => {
    const index = readIndexUnlocked();
    const set = new Set(index.active_tasks);
    if (active) set.add(taskId);
    else set.delete(taskId);
    return writeIndexUnlocked({
      active_tasks: [...set],
      done_tasks: index.done_tasks,
      updated_at: nowIso(),
    });
  });
}

export type ActivateWithAdmissionResult =
  | { ok: true; index: RrAfkTaskIndex }
  | { ok: false; reason: 'afk_budget_capacity' };

/** Check admission cap and activate task atomically under index lock. */
export function activateTaskWithAdmissionCap(
  taskId: string,
  cap: number,
  force?: boolean,
): ActivateWithAdmissionResult {
  return withIndexLock(() => {
    const index = readIndexUnlocked();
    if (index.active_tasks.includes(taskId)) {
      return { ok: true, index };
    }
    if (!force && index.active_tasks.length >= cap) {
      return { ok: false, reason: 'afk_budget_capacity' };
    }
    const set = new Set(index.active_tasks);
    set.add(taskId);
    return {
      ok: true,
      index: writeIndexUnlocked({
        active_tasks: [...set],
        done_tasks: index.done_tasks,
        updated_at: nowIso(),
      }),
    };
  });
}

function patchTaskStatus(taskId: string, status: RrAfkState['status']): RrAfkState | null {
  const state = readState(taskId);
  if (!state) return null;
  return writeState(taskId, { ...state, status, updated_at: nowIso() });
}

export function pauseTask(taskId: string): RrAfkState | null {
  return withIndexLock(() => {
    const index = readIndexUnlocked();
    const active_tasks = index.active_tasks.filter((id) => id !== taskId);
    writeIndexUnlocked({
      active_tasks,
      done_tasks: index.done_tasks,
      updated_at: nowIso(),
    });
    return patchTaskStatus(taskId, 'PAUSED');
  });
}

export function pauseAll(): RrAfkState[] {
  return withIndexLock(() => {
    const index = readIndexUnlocked();
    const active = [...index.active_tasks];
    const paused: RrAfkState[] = [];
    for (const taskId of active) {
      const state = patchTaskStatus(taskId, 'PAUSED');
      if (state) paused.push(state);
    }
    writeIndexUnlocked({ active_tasks: [], done_tasks: index.done_tasks, updated_at: nowIso() });
    return paused;
  });
}

export function resumeTask(
  taskId: string,
  options?: { admissionCap?: number; force?: boolean },
): RrAfkState | null {
  const state = readState(taskId);
  if (!state) return null;
  if (options?.admissionCap !== undefined) {
    const admission = activateTaskWithAdmissionCap(taskId, options.admissionCap, options.force);
    if (!admission.ok) throw new Error(admission.reason);
  } else {
    setTaskActive(taskId, true);
  }
  const nextStatus = state.status === 'PAUSED' ? 'READY' : state.status;
  return writeState(taskId, { ...state, status: nextStatus, updated_at: nowIso() });
}

function newRootIsEmpty(): boolean {
  ensureAfkRoot();
  const root = tasksRoot();
  if (!existsSync(root)) return true;
  const index = readIndex();
  if (index.active_tasks.length > 0) return false;
  const taskIds = listTaskIds();
  return taskIds.length === 0;
}

function readLegacyText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function detectLegacyTaskDir(root: string): string | null {
  if (!existsSync(root)) return null;
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((dir) => existsSync(join(dir, 'CRITERIA.md')) || existsSync(join(dir, 'TODO.md')));
  if (entries.length === 0) return null;
  return entries.sort((a, b) => {
    const aStat = statSync(a);
    const bStat = statSync(b);
    return bStat.mtimeMs - aStat.mtimeMs;
  })[0] ?? null;
}

function copyIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
  copyFileSync(source, target);
}

function copyLegacyArtifacts(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  for (const name of ['PLAN.md', 'CRITERIA.md', 'TASKS.md', 'TODO.md', 'DECISIONS.md']) {
    copyIfExists(join(sourceDir, name), join(targetDir, name));
  }
}

export function migrateLegacyFlagsIfNeeded(): { migrated: boolean; taskId: string | null } {
  if (!newRootIsEmpty()) return { migrated: false, taskId: null };

  const legacyRoot = legacyAfkRoot();
  if (!existsSync(legacyRoot)) return { migrated: false, taskId: null };

  const hasActive = existsSync(join(legacyRoot, 'ACTIVE'));
  const hasPause = existsSync(join(legacyRoot, 'PAUSE'));
  const hasDone = existsSync(join(legacyRoot, 'DONE'));
  const maxLoopsRaw = readLegacyText(join(legacyRoot, 'MAX_LOOPS'));
  const maxLoops = maxLoopsRaw ? Number(maxLoopsRaw.trim()) || DEFAULT_MAX_LOOPS : DEFAULT_MAX_LOOPS;
  const legacyTaskDir = detectLegacyTaskDir(legacyRoot);

  if (!hasActive && !hasPause && !hasDone && !maxLoopsRaw && !legacyTaskDir) {
    return { migrated: false, taskId: null };
  }

  const taskId = legacyTaskDir ? basename(legacyTaskDir) : 'legacy-task';
  const status: RrAfkState['status'] = hasDone
    ? 'DONE'
    : hasPause
      ? 'PAUSED'
      : hasActive
        ? 'RUNNING'
        : 'PLANNING';

  ensureAfkRoot();
  const targetDir = taskDir(taskId);
  if (legacyTaskDir) {
    copyLegacyArtifacts(legacyTaskDir, targetDir);
  } else {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(targetDir, 'CRITERIA.md'), defaultCriteria(), 'utf8');
    writeFileSync(join(targetDir, 'TODO.md'), defaultTodo(), 'utf8');
  }

  const timestamp = nowIso();
  const state: RrAfkState = {
    task_id: taskId,
    status,
    master_session_id: null,
    project_root: process.cwd(),
    current_unit: null,
    plan_revision: 0,
    loop: 0,
    max_loops: maxLoops,
    allowlist: [],
    permission_request: null,
    last_command: null,
    last_verification: null,
    human_action_hint: hasPause
      ? 'Migrated from legacy ~/.cursor/afk PAUSE flag.'
      : hasDone
        ? 'Migrated from legacy ~/.cursor/afk DONE flag.'
        : null,
    updated_at: timestamp,
  };

  writeState(taskId, state);
  appendEvent(taskId, { at: timestamp, kind: 'legacy_migrated', detail: { legacyRoot, status, maxLoops } });

  const activeTasks = hasActive && !hasPause && !hasDone ? [taskId] : [];
  const doneTasks = hasDone ? [taskId] : [];
  writeIndex({ active_tasks: activeTasks, done_tasks: doneTasks, updated_at: timestamp });

  return { migrated: true, taskId };
}

export function initTaskArtifacts(input: InitTaskArtifactsInput): {
  taskId: string;
  taskDir: string;
  state: RrAfkState;
  summary: RrAfkSummary;
  index: RrAfkTaskIndex;
} {
  ensureAfkRoot();
  migrateLegacyFlagsIfNeeded();

  const taskId = input.taskId;
  const dir = taskDir(taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const artifacts: Array<[string, string]> = [
    ['PLAN.md', input.plan ?? defaultPlan(taskId)],
    ['CRITERIA.md', input.criteria ?? defaultCriteria()],
    ['TASKS.md', input.tasks ?? defaultTasks()],
    ['TODO.md', input.tasks ?? defaultTodo()],
    ['DECISIONS.md', defaultDecisions()],
  ];
  for (const [name, content] of artifacts) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, content, 'utf8');
  }

  const timestamp = nowIso();
  const maxLoops = input.maxLoops ?? DEFAULT_MAX_LOOPS;
  const state: RrAfkState = {
    task_id: taskId,
    status: 'PLANNING',
    master_session_id: input.masterSessionId,
    project_root: input.projectRoot,
    current_unit: null,
    plan_revision: 0,
    loop: 0,
    max_loops: maxLoops,
    allowlist: [],
    permission_request: null,
    last_command: null,
    last_verification: null,
    human_action_hint: null,
    updated_at: timestamp,
    ...(input.mode ? { mode: input.mode } : {}),
  };

  writeState(taskId, state);
  appendEvent(taskId, {
    at: timestamp,
    kind: 'task_initialized',
    detail: { projectRoot: input.projectRoot, mode: input.mode ?? null },
  });

  let index: RrAfkTaskIndex;
  if (input.activate === false) {
    index = readIndex();
  } else if (input.admissionCap !== undefined) {
    const admission = activateTaskWithAdmissionCap(taskId, input.admissionCap, input.admissionForce);
    if (!admission.ok) throw new Error(admission.reason);
    index = admission.index;
  } else {
    index = setTaskActive(taskId, true);
  }

  const summary = readSummary(taskId)!;
  return { taskId, taskDir: dir, state, summary, index };
}

export { resolveActiveTasks };
