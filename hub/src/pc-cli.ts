#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

export const DEFAULT_HUB_URL = 'http://127.0.0.1:8040';

export interface PcCliDeps {
  hubUrl?: string;
  fetchFn?: typeof fetch;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface HubCall {
  method: string;
  path: string;
  body?: unknown;
}

function defaultStdout(line: string): void {
  console.log(line);
}

function defaultStderr(line: string): void {
  console.error(line);
}

export function resolveHubUrl(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const raw = override ?? env.PC_HUB_URL ?? DEFAULT_HUB_URL;
  return raw.replace(/\/$/, '');
}

export function joinHubPath(base: string, path: string): string {
  const normalizedBase = base.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export function takeFlag(args: readonly string[], flag: string): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === flag) {
      const next = args[index + 1];
      if (next == null || next.startsWith('-')) throw new Error(`missing_value:${flag}`);
      value = next;
      index += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      value = token.slice(flag.length + 1);
      continue;
    }
    rest.push(token);
  }
  return { value, rest };
}

export function takeRepeatedFlag(args: readonly string[], flag: string): { values: string[]; rest: string[] } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (token === flag) {
      const next = args[index + 1];
      if (next == null || next.startsWith('-')) throw new Error(`missing_value:${flag}`);
      values.push(next);
      index += 1;
      continue;
    }
    if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
      continue;
    }
    rest.push(token);
  }
  return { values, rest };
}

export function buildHeartbeatSpec(taskId?: string): string {
  const tick = taskId ? `pc afk tick --task-id ${taskId}` : 'pc afk tick';
  return [
    'PolarCopilot AFK heartbeat (Codex scheduled).',
    'Run exactly one shell command, print its stdout/stderr, then stop.',
    'Do not read files, plan, or ask questions.',
    '',
    tick,
  ].join('\n');
}

export function buildLoopPrompt(): string {
  return [
    'PolarCopilot AFK /loop bridge.',
    'In this turn only:',
    '1. Run `pc afk tick` via shell.',
    '2. Print the command JSON output.',
    '3. On its own line, print: RR_ORCH_TICK {"action":"tick"}',
    'Do not wait for user input.',
  ].join('\n');
}

export function usageText(): string {
  return `Usage: pc afk <command> [options]

Commands:
  start [--session-id ID] [--no-spawn] [--task-slug SLUG] [--task-dir DIR] [--project ROOT] [--mode start|solo|go] [--force] [--no-orchestrator]
  status [--json] [--project ROOT]
  summary
  pause [taskId]
  resume [taskId]
  done <taskId>
  tick [--task-id ID]
  inject <sessionId> <text...>
  grant --task ID --path PATH [--path PATH ...] --confirmed
  set-heartbeat --task ID --automation-id ID
  report
  halt
  heartbeat-spec [--task-id ID]
  loop-prompt
  gate-check --conversation-id ID [--cwd PATH]   (local vNext; for stop hook)
  ide-bind --conversation-id ID --project ROOT [--goal TEXT] [--task-id ID]
  migrate-dry-run [--root PATH]                  (local vNext file→SQLite dry-run)

Environment:
  PC_HUB_URL    Hub base URL (default ${DEFAULT_HUB_URL})
  POLAR_AFK_DB  AFK vNext SQLite path (default ~/.polar-copilot/afk/afk.db)
`;
}

export function parseAfkCommand(args: readonly string[]): { command: string; rest: string[] } {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    throw new Error('usage');
  }
  return { command: args[0]!, rest: args.slice(1) };
}

export async function hubRequest(
  hubUrl: string,
  call: HubCall,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const init: RequestInit = { method: call.method };
  if (call.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(call.body);
  }
  const response = await fetchFn(joinHubPath(hubUrl, call.path), init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Hub ${response.status} ${call.path}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) as unknown : { ok: true };
}

export function resolveAfkCall(command: string, rest: string[]): HubCall | 'print' {
  switch (command) {
    case 'start': {
      const body: Record<string, unknown> = { spawnIfNeeded: true, startOrchestrator: true };
      const sessionId = takeFlag(rest, '--session-id');
      let args = sessionId.rest;
      if (sessionId.value) body.sessionId = sessionId.value;
      const slug = takeFlag(args, '--task-slug');
      args = slug.rest;
      if (slug.value) body.taskSlug = slug.value;
      const taskDir = takeFlag(args, '--task-dir');
      args = taskDir.rest;
      if (taskDir.value) body.taskDir = taskDir.value;
      const project = takeFlag(args, '--project');
      args = project.rest;
      if (project.value) body.projectRoot = project.value;
      const mode = takeFlag(args, '--mode');
      args = mode.rest;
      if (mode.value) body.mode = mode.value;
      if (hasFlag(args, '--force')) body.force = true;
      if (hasFlag(args, '--no-orchestrator')) body.startOrchestrator = false;
      if (hasFlag(args, '--no-spawn')) body.spawnIfNeeded = false;
      args = args.filter((token) =>
        token !== '--force' && token !== '--no-orchestrator' && token !== '--no-spawn',
      );
      if (args.length > 0) throw new Error(`unknown_args:${args.join(' ')}`);
      return { method: 'POST', path: '/api/ui/rr/afk/one-click', body };
    }
    case 'status': {
      const project = takeFlag(rest, '--project');
      const args = project.rest;
      if (args.some((token) => token !== '--json')) throw new Error(`unknown_args:${args.filter((t) => t !== '--json').join(' ')}`);
      const query = project.value ? `?projectRoot=${encodeURIComponent(project.value)}` : '';
      return { method: 'GET', path: `/api/ui/rr/afk/status${query}` };
    }
    case 'summary':
      if (rest.length > 0) throw new Error(`unknown_args:${rest.join(' ')}`);
      return { method: 'GET', path: '/api/ui/rr/afk/summary' };
    case 'pause': {
      const [taskId] = rest;
      if (rest.length > 1) throw new Error(`unknown_args:${rest.slice(1).join(' ')}`);
      return { method: 'POST', path: '/api/ui/rr/afk/pause', body: taskId ? { taskId } : {} };
    }
    case 'resume': {
      const [taskId] = rest;
      if (rest.length > 1) throw new Error(`unknown_args:${rest.slice(1).join(' ')}`);
      return { method: 'POST', path: '/api/ui/rr/afk/resume', body: taskId ? { taskId } : {} };
    }
    case 'done': {
      const [taskId] = rest;
      if (!taskId) throw new Error('missing_value:taskId');
      if (rest.length > 1) throw new Error(`unknown_args:${rest.slice(1).join(' ')}`);
      return { method: 'POST', path: '/api/ui/rr/afk/done', body: { taskId } };
    }
    case 'tick': {
      const taskId = takeFlag(rest, '--task-id');
      if (taskId.rest.length > 0) throw new Error(`unknown_args:${taskId.rest.join(' ')}`);
      return {
        method: 'POST',
        path: '/api/ui/rr/afk/tick',
        body: taskId.value ? { taskId: taskId.value } : {},
      };
    }
    case 'inject': {
      const [sessionId, ...parts] = rest;
      if (!sessionId || parts.length === 0) throw new Error('usage');
      return {
        method: 'POST',
        path: `/api/ui/rr/sessions/${encodeURIComponent(sessionId)}/messages`,
        body: { content: parts.join(' ') },
      };
    }
    case 'grant': {
      const task = takeFlag(rest, '--task');
      let args = task.rest;
      if (!task.value) throw new Error('missing_value:--task');
      const paths = takeRepeatedFlag(args, '--path');
      args = paths.rest;
      if (paths.values.length === 0) throw new Error('missing_value:--path');
      if (!hasFlag(args, '--confirmed')) throw new Error('missing_flag:--confirmed');
      args = args.filter((token) => token !== '--confirmed');
      if (args.length > 0) throw new Error(`unknown_args:${args.join(' ')}`);
      return {
        method: 'POST',
        path: `/api/ui/rr/afk/${encodeURIComponent(task.value)}/grant-temporary-paths`,
        body: { paths: paths.values, confirmed: true },
      };
    }
    case 'set-heartbeat': {
      const task = takeFlag(rest, '--task');
      let args = task.rest;
      if (!task.value) throw new Error('missing_value:--task');
      const automation = takeFlag(args, '--automation-id');
      args = automation.rest;
      if (!automation.value) throw new Error('missing_value:--automation-id');
      if (args.length > 0) throw new Error(`unknown_args:${args.join(' ')}`);
      return {
        method: 'POST',
        path: '/api/ui/rr/afk/set-heartbeat',
        body: { taskId: task.value, automationId: automation.value },
      };
    }
    case 'report':
      if (rest.length > 0) throw new Error(`unknown_args:${rest.join(' ')}`);
      return { method: 'GET', path: '/api/ui/rr/afk/report' };
    case 'halt':
      if (rest.length > 0) throw new Error(`unknown_args:${rest.join(' ')}`);
      return { method: 'POST', path: '/api/ui/rr/afk/orchestrator/halt' };
    case 'heartbeat-spec':
      return 'print';
    case 'loop-prompt':
      return 'print';
    default:
      throw new Error(`unknown_command:${command}`);
  }
}

function formatActiveTaskLine(task: Record<string, unknown>): string {
  const parts = [
    String(task.taskId ?? '-'),
    `status=${String(task.status ?? '-')}`,
    `loop=${String(task.loopCount ?? 0)}/${String(task.maxLoops ?? 0)}`,
  ];
  if (task.masterSessionId) parts.push(`master=${String(task.masterSessionId)}`);
  if (task.paused) parts.push('paused');
  if (task.done) parts.push('done');
  if (task.projectRoot) parts.push(`root=${String(task.projectRoot)}`);
  return `  - ${parts.join(' · ')}`;
}

function formatStatus(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return JSON.stringify(payload, null, 2);
  const status = payload as Record<string, unknown>;
  const lines = [
    `active: ${String(status.active ?? false)}`,
    `taskId: ${String(status.taskId ?? '-')} (primary compat mirror)`,
    `loopCount: ${String(status.loopCount ?? 0)}`,
    `orchestrator: ${JSON.stringify(status.orchestrator ?? {})}`,
  ];
  const activeTasks = status.activeTasks;
  if (Array.isArray(activeTasks) && activeTasks.length > 0) {
    lines.push(`activeTasks (${activeTasks.length}):`);
    for (const item of activeTasks) {
      if (item && typeof item === 'object') {
        lines.push(formatActiveTaskLine(item as Record<string, unknown>));
      }
    }
  } else {
    const indexTasks = (status.index as Record<string, unknown> | undefined)?.active_tasks;
    if (Array.isArray(indexTasks) && indexTasks.length > 0) {
      lines.push(`activeTasks (${indexTasks.length}):`);
      for (const taskId of indexTasks) {
        lines.push(`  - ${String(taskId)}`);
      }
    } else {
      lines.push('activeTasks: (none)');
    }
  }
  const todo = status.todo;
  if (todo && typeof todo === 'object') {
    const todoObj = todo as Record<string, unknown>;
    lines.push(`todo: pending=${String(todoObj.pending ?? 0)} done=${String(todoObj.done ?? 0)}`);
  }
  return lines.join('\n');
}

export async function runPcCli(argv: string[], deps: PcCliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const hubUrl = resolveHubUrl(process.env, deps.hubUrl);
  const fetchFn = deps.fetchFn ?? fetch;

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    stderr(usageText());
    return 2;
  }

  if (argv[0] !== 'afk') {
    stderr(`Unknown top-level command: ${argv[0]}\n\n${usageText()}`);
    return 2;
  }

  try {
    const { command, rest } = parseAfkCommand(argv.slice(1));

    if (command === 'heartbeat-spec') {
      const taskId = takeFlag(rest, '--task-id');
      if (taskId.rest.length > 0) throw new Error(`unknown_args:${taskId.rest.join(' ')}`);
      stdout(buildHeartbeatSpec(taskId.value));
      return 0;
    }

    if (command === 'loop-prompt') {
      if (rest.length > 0) throw new Error(`unknown_args:${rest.join(' ')}`);
      stdout(buildLoopPrompt());
      return 0;
    }

    if (command === 'gate-check') {
      const conv = takeFlag(rest, '--conversation-id');
      let args = conv.rest;
      if (!conv.value) throw new Error('missing_value:--conversation-id');
      const cwd = takeFlag(args, '--cwd');
      args = cwd.rest;
      if (args.length > 0) throw new Error(`unknown_args:${args.join(' ')}`);
      const { openAfkDb } = await import('./rr/afk/vnext/db.js');
      const { gateCheckForConversation } = await import('./rr/afk/vnext/ide-adapter.js');
      const db = openAfkDb();
      try {
        const result = gateCheckForConversation(db, conv.value, cwd.value);
        stdout(JSON.stringify({ ...result, ok: result.ok }, null, 0));
      } finally {
        db.close();
      }
      return 0;
    }

    if (command === 'ide-bind') {
      const conv = takeFlag(rest, '--conversation-id');
      let args = conv.rest;
      if (!conv.value) throw new Error('missing_value:--conversation-id');
      const project = takeFlag(args, '--project');
      args = project.rest;
      if (!project.value) throw new Error('missing_value:--project');
      const goal = takeFlag(args, '--goal');
      args = goal.rest;
      const task = takeFlag(args, '--task-id');
      args = task.rest;
      if (args.length > 0) throw new Error(`unknown_args:${args.join(' ')}`);
      const { openAfkDb } = await import('./rr/afk/vnext/db.js');
      const { bindIdeConversation } = await import('./rr/afk/vnext/ide-adapter.js');
      const db = openAfkDb();
      try {
        const row = bindIdeConversation(db, {
          conversationId: conv.value,
          projectRoot: project.value,
          goal: goal.value,
          taskId: task.value,
        });
        stdout(JSON.stringify({ ok: true, task: row }, null, 2));
      } finally {
        db.close();
      }
      return 0;
    }

    if (command === 'migrate-dry-run') {
      const root = takeFlag(rest, '--root');
      if (root.rest.length > 0) throw new Error(`unknown_args:${root.rest.join(' ')}`);
      const { openAfkDb } = await import('./rr/afk/vnext/db.js');
      const { migrateFromFileRoot } = await import('./rr/afk/vnext/migrate.js');
      const { afkRoot } = await import('./rr/afk/paths.js');
      const db = openAfkDb();
      try {
        const report = migrateFromFileRoot(db, root.value ?? afkRoot(), { dryRun: true });
        stdout(JSON.stringify(report, null, 2));
      } finally {
        db.close();
      }
      return 0;
    }

    const call = resolveAfkCall(command, rest);
    if (call === 'print') {
      return 0;
    }

    const payload = await hubRequest(hubUrl, call, fetchFn);
    if (command === 'status' && !hasFlag(rest, '--json')) {
      stdout(formatStatus(payload));
    } else {
      stdout(JSON.stringify(payload, null, 2));
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'usage') {
      stderr(usageText());
      return 2;
    }
    stderr(message);
    return 1;
  }
}

async function main(): Promise<void> {
  const code = await runPcCli(process.argv.slice(2));
  process.exit(code);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entry) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}