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

function nowIso(): string {
  return new Date().toISOString();
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
  return '# Acceptance Criteria\n\n- [ ] `npm test` passes\n';
}

function defaultTasks(): string {
  return '# Task Units\n\n## U1\n\n- Scope: first change\n- Verify: npm test\n';
}

function defaultTodo(): string {
  return '# TODO\n\n- [ ] U1 — first atomic unit\n';
}

function defaultDecisions(): string {
  return '# Decisions Log\n\n<!-- Record non-obvious choices during AFK -->\n';
}

export function ensureAfkRoot(): string {
  const root = afkRoot();
  mkdirSync(join(root, 'tasks'), { recursive: true, mode: 0o700 });
  return root;
}

export function readIndex(): RrAfkTaskIndex {
  ensureAfkRoot();
  const path = indexPath();
  if (!existsSync(path)) {
    return { active_tasks: [], updated_at: nowIso() };
  }
  try {
    const raw = readJson<Partial<RrAfkTaskIndex>>(path);
    return {
      active_tasks: Array.isArray(raw.active_tasks)
        ? raw.active_tasks.filter((taskId): taskId is string => typeof taskId === 'string' && TASK_ID_PATTERN.test(taskId))
        : [],
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : nowIso(),
    };
  } catch {
    return { active_tasks: [], updated_at: nowIso() };
  }
}

export function writeIndex(index: RrAfkTaskIndex): RrAfkTaskIndex {
  ensureAfkRoot();
  const next: RrAfkTaskIndex = {
    active_tasks: [...new Set(index.active_tasks)],
    updated_at: index.updated_at || nowIso(),
  };
  atomicJson(indexPath(), next);
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
    allowlist: [...state.allowlist],
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
  const next = { ...state, task_id: taskId, updated_at: state.updated_at || nowIso() };
  atomicJson(statePath(taskId), next);
  writeSummary(taskId, summaryFromState(next));
  return next;
}

export function readSummary(taskId: string): RrAfkSummary | null {
  const path = summaryPath(taskId);
  if (!existsSync(path)) {
    const state = readState(taskId);
    return state ? summaryFromState(state) : null;
  }
  try {
    return readJson<RrAfkSummary>(path);
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
  summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return summaries;
}

export function setTaskActive(taskId: string, active: boolean): RrAfkTaskIndex {
  const index = readIndex();
  const set = new Set(index.active_tasks);
  if (active) set.add(taskId);
  else set.delete(taskId);
  return writeIndex({ active_tasks: [...set], updated_at: nowIso() });
}

function patchTaskStatus(taskId: string, status: RrAfkState['status']): RrAfkState | null {
  const state = readState(taskId);
  if (!state) return null;
  return writeState(taskId, { ...state, status, updated_at: nowIso() });
}

export function pauseTask(taskId: string): RrAfkState | null {
  setTaskActive(taskId, false);
  return patchTaskStatus(taskId, 'PAUSED');
}

export function pauseAll(): RrAfkState[] {
  const active = resolveActiveTasks();
  const paused: RrAfkState[] = [];
  for (const taskId of active) {
    const state = pauseTask(taskId);
    if (state) paused.push(state);
  }
  writeIndex({ active_tasks: [], updated_at: nowIso() });
  return paused;
}

export function resumeTask(taskId: string): RrAfkState | null {
  const state = readState(taskId);
  if (!state) return null;
  const nextStatus = state.status === 'PAUSED' ? 'READY' : state.status;
  const next = writeState(taskId, { ...state, status: nextStatus, updated_at: nowIso() });
  setTaskActive(taskId, true);
  return next;
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
  writeIndex({ active_tasks: activeTasks, updated_at: timestamp });

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

  const index = input.activate === false
    ? readIndex()
    : setTaskActive(taskId, true);

  const summary = readSummary(taskId)!;
  return { taskId, taskDir: dir, state, summary, index };
}

export { resolveActiveTasks };
