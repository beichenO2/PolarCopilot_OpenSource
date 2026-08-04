/**
 * Web surface executor: PolarProcess-managed cursor-agent CLI.
 * Does NOT use rr-chat / hub-agent MCP as a message bus.
 */
import type { AfkDb } from './db.js';
import { newId, nowIso } from './db.js';
import { bindOwnerRun, createTask, getTask, transitionTask } from './store.js';
import type { AfkTaskRow } from './types.js';

export interface WebTaskCreateInput {
  goal: string;
  projectRoot: string;
  mode?: 'start' | 'solo';
  taskId?: string;
  priority?: number;
}

export function createWebTask(db: AfkDb, input: WebTaskCreateInput): AfkTaskRow {
  const task = createTask(db, {
    taskId: input.taskId,
    goal: input.goal,
    projectRoot: input.projectRoot,
    surface: 'web',
    mode: input.mode ?? 'solo',
    status: 'QUEUED',
    priority: input.priority ?? 0,
  });
  return task;
}

export interface CliRunSpec {
  taskId: string;
  /** chat id from `cursor-agent create-chat` or previous attempt */
  nativeHandle?: string | null;
  resume: boolean;
  prompt: string;
  workspace: string;
  serviceId: string;
}

/**
 * Build PolarProcess registration for a foreground cursor-agent run.
 *
 * Important (PolarProcess reality):
 * - Prefer service id prefix `cursor-cli-…` so DELETE needs no confirm (ephemeral).
 * - Put chatId/prompt **in `command`**, not `env` — register.env is not reliably injected today.
 * - One shared `Start/afk-cli/start.sh`; N tasks = N register rows with different argv, not N scripts.
 */
export function buildCursorAgentProcessCommand(spec: CliRunSpec): {
  id: string;
  name: string;
  command: string;
  work_dir: string;
  auto_start: false;
  restart_on_failure: false;
  start_script_dir: string;
} {
  const chat = spec.nativeHandle ?? '';
  const prompt = spec.prompt.replace(/'/g, `'\\''`);
  const command = chat
    ? `bash Start/afk-cli/start.sh ${shellQuote(chat)} ${shellQuote(prompt)}`
    : `bash Start/afk-cli/start.sh '' ${shellQuote(prompt)}`;

  const id = spec.serviceId.startsWith('cursor-cli-')
    ? spec.serviceId
    : `cursor-cli-afk-${spec.taskId}`.slice(0, 80);

  return {
    id,
    name: `AFK CLI ${spec.taskId}`,
    command,
    work_dir: spec.workspace,
    auto_start: false,
    restart_on_failure: false,
    start_script_dir: 'Start/afk-cli',
  };
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function attachCliOwnerRun(
  db: AfkDb,
  taskId: string,
  nativeHandle: string | null,
  serviceId: string,
): string {
  const bound = bindOwnerRun(db, {
    taskId,
    executorKind: 'cursor-cli',
    nativeHandle,
    serviceId,
  });
  if (!bound.ok) throw new Error(bound.error.message);
  const task = getTask(db, taskId);
  if (task && (task.status === 'QUEUED' || task.status === 'PLANNING' || task.status === 'DRAFT')) {
    if (task.status === 'DRAFT') transitionTask(db, taskId, 'PLANNING');
    if (getTask(db, taskId)?.status === 'PLANNING') transitionTask(db, taskId, 'QUEUED');
    transitionTask(db, taskId, 'RUNNING', { reason: 'cli_start' });
  }
  return bound.value.run_id;
}

/** Conservative concurrency when Budget unreachable. */
export function resolveExecConcurrency(budgetRecommended: number | null): number {
  if (budgetRecommended == null || !Number.isFinite(budgetRecommended)) return 1;
  return Math.max(1, Math.floor(budgetRecommended));
}

export function pickNextQueuedTask(db: AfkDb): AfkTaskRow | null {
  const row = db
    .prepare(
      `SELECT * FROM tasks WHERE status = 'QUEUED'
       ORDER BY priority DESC, COALESCE(last_scheduled_at, created_at) ASC
       LIMIT 1`,
    )
    .get() as AfkTaskRow | undefined;
  return row ?? null;
}

export function markScheduled(db: AfkDb, taskId: string): void {
  db.prepare('UPDATE tasks SET last_scheduled_at = ?, updated_at = ? WHERE task_id = ?').run(
    nowIso(),
    nowIso(),
    taskId,
  );
}

export function buildRecoveryPrompt(taskId: string, goal: string): string {
  return [
    `[AFK_CLI_RESUME] task_id=${taskId}`,
    `Goal: ${goal}`,
    'Load CRITERIA.md / TODO.md / DECISIONS.md / EVIDENCE.md and AFK DB state for this task.',
    'Continue never-ask until completion gate passes or whitelisted NEEDS_HUMAN.',
    'Do not use rr-chat / hub-agent MCP as control plane.',
    `attempt_token=${newId('attempt')}`,
  ].join('\n');
}
