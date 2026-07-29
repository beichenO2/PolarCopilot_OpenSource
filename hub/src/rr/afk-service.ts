import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCriteriaSummary, parseTodoItems, readAfkSnapshot } from './orchestrator/afk-state.js';
import { globalConfigPath, loadConfig, patchGlobalConfig } from './orchestrator/config.js';
import { readOrchestratorHealth } from './orchestrator/health.js';
import {
  haltOrchestratorService,
  readOrchestratorServiceState,
  startOrchestratorService,
} from './orchestrator/polar-service.js';
import { loadState } from './orchestrator/state.js';
import type { RrFileStore } from './store.js';
import type { RrSession } from './types.js';

export interface RrAfkArmInput {
  taskDir?: string;
  taskSlug?: string;
  maxLoops?: number;
  force?: boolean;
  projectRoot?: string;
  masterSessionId?: string;
}

export interface RrAfkOneClickInput extends RrAfkArmInput {
  sessionId?: string;
  spawnIfNeeded?: boolean;
  startOrchestrator?: boolean;
}

export interface RrAfkTodoProgress {
  total: number;
  pending: number;
  done: number;
  pendingItems: string[];
}

export interface RrAfkStatus {
  ok: boolean;
  active: boolean;
  paused: boolean;
  done: boolean;
  maxLoops: number;
  loopCount: number;
  taskDir: string | null;
  todo: RrAfkTodoProgress;
  criteria: { count: number; summary: string[] };
  orchestrator: {
    enabled: boolean;
    running: boolean;
    serviceStatus: string | null;
    masterSessionId: string | null;
    lastAction: string | null;
    lastInjectAt: number | null;
    lastSessionId: string | null;
  };
  projectRoot: string;
  health: ReturnType<typeof readOrchestratorHealth>;
}

function countTodoProgress(todoText: string | null): RrAfkTodoProgress {
  if (!todoText) {
    return { total: 0, pending: 0, done: 0, pendingItems: [] };
  }
  const lines = todoText.split('\n').map((line) => line.trim());
  const pendingItems = parseTodoItems(todoText);
  const pending = pendingItems.length;
  const done = lines.filter((line) => /^[-*]\s+\[x\]/i.test(line)).length;
  return {
    total: pending + done,
    pending,
    done,
    pendingItems: pendingItems.slice(0, 8),
  };
}

function resolveTaskDir(input: RrAfkArmInput, afkRoot: string, config: ReturnType<typeof loadConfig>): string | null {
  if (input.taskDir) return input.taskDir;
  if (input.taskSlug) return join(afkRoot, input.taskSlug);
  return readAfkSnapshot(config).taskDir;
}

export function pickMasterSession(sessions: RrSession[], preferredId?: string | null): RrSession | null {
  const masters = sessions.filter((session) => !session.isSubagent);
  if (preferredId) {
    const preferred = masters.find((session) => session.sessionId === preferredId);
    if (preferred) return preferred;
  }
  const online = masters
    .filter((session) => session.online || session.status === 'waiting')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  if (online.length > 0) return online[0] ?? null;
  return masters.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
}

export async function readAfkStatus(projectRoot?: string): Promise<RrAfkStatus> {
  const config = loadConfig(projectRoot);
  const afk = readAfkSnapshot(config);
  const state = loadState(config.statePath);
  const health = readOrchestratorHealth(config.projectRoot);
  const service = await readOrchestratorServiceState();
  const criteriaSummary = parseCriteriaSummary(afk.criteriaText);

  return {
    ok: health.ok && service.running,
    active: afk.active,
    paused: afk.paused || state.paused,
    done: afk.done,
    maxLoops: afk.maxLoops,
    loopCount: state.loopCount,
    taskDir: afk.taskDir,
    todo: countTodoProgress(afk.todoText),
    criteria: { count: criteriaSummary.length, summary: criteriaSummary.slice(0, 6) },
    orchestrator: {
      enabled: service.enabled,
      running: service.running,
      serviceStatus: service.serviceStatus,
      masterSessionId: config.masterSessionId,
      lastAction: state.lastAction,
      lastInjectAt: state.lastInjectedAt,
      lastSessionId: state.lastSessionId,
    },
    projectRoot: config.projectRoot,
    health,
  };
}

export function armAfk(input: RrAfkArmInput = {}): {
  armed: true;
  afkRoot: string;
  taskDir: string | null;
  maxLoops: number;
  masterSessionId: string | null;
} {
  const config = loadConfig(input.projectRoot);
  const afkRoot = config.afkRoot;
  mkdirSync(afkRoot, { recursive: true, mode: 0o700 });

  const activePath = join(afkRoot, 'ACTIVE');
  if (existsSync(activePath) && !input.force) {
    throw new Error('afk_already_active');
  }

  for (const flag of ['PAUSE', 'DONE', 'ERROR_RETRY']) {
    rmSync(join(afkRoot, flag), { force: true });
  }

  const maxLoops = input.maxLoops ?? config.maxLoops ?? 40;
  writeFileSync(join(afkRoot, 'MAX_LOOPS'), `${maxLoops}\n`, 'utf8');
  writeFileSync(activePath, '', 'utf8');

  const taskDir = resolveTaskDir(input, afkRoot, config);
  if (taskDir && existsSync(taskDir)) {
    const currentLink = join(afkRoot, 'current');
    rmSync(currentLink, { recursive: true, force: true });
    try {
      symlinkSync(taskDir, currentLink);
    } catch {
      // best-effort; task dir may still be detected via CRITERIA/TODO files
    }
  }

  let masterSessionId = input.masterSessionId ?? null;
  if (masterSessionId) {
    patchGlobalConfig({ masterSessionId }, globalConfigPath());
  }

  return {
    armed: true,
    afkRoot,
    taskDir: taskDir && existsSync(taskDir) ? taskDir : null,
    maxLoops,
    masterSessionId,
  };
}

export function configureMasterSession(sessionId: string, projectRoot?: string): string {
  patchGlobalConfig({
    masterSessionId: sessionId,
    ...(projectRoot ? { projectRoot } : {}),
  });
  return sessionId;
}

export async function oneClickAfk(
  store: RrFileStore,
  input: RrAfkOneClickInput = {},
): Promise<{
  ok: true;
  sessionId: string;
  armed: ReturnType<typeof armAfk>;
  orchestrator: Awaited<ReturnType<typeof startOrchestratorService>>;
  status: RrAfkStatus;
}> {
  const sessions = store.listSessions();
  let master = pickMasterSession(sessions, input.sessionId ?? input.masterSessionId);
  if (!master) {
    if (!input.spawnIfNeeded) throw new Error('no_master_session');
    const created = store.register({
      launchId: `rrlaunch-afk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Rr Agent · AFK',
      role: 'general-purpose',
    });
    master = created.session;
  }

  const armed = armAfk({
    ...input,
    force: input.force ?? false,
    masterSessionId: master.sessionId,
  });
  configureMasterSession(master.sessionId, input.projectRoot);

  const orchestrator = input.startOrchestrator === false
    ? {
      enabled: (await readOrchestratorServiceState()).enabled,
      polarprocess: null,
      running: (await readOrchestratorServiceState()).running,
    }
    : await startOrchestratorService();

  const status = await readAfkStatus(input.projectRoot);
  return {
    ok: true,
    sessionId: master.sessionId,
    armed,
    orchestrator,
    status,
  };
}

export async function startAfkOrchestrator() {
  return startOrchestratorService();
}

export async function haltAfkOrchestrator() {
  return haltOrchestratorService();
}

export function readAfkRoot(): string {
  return join(homedir(), '.cursor', 'afk');
}

export function isAfkActive(): boolean {
  return existsSync(join(readAfkRoot(), 'ACTIVE'));
}

export function readMaxLoops(): number {
  try {
    const raw = readFileSync(join(readAfkRoot(), 'MAX_LOOPS'), 'utf8').trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 40;
  } catch {
    return 40;
  }
}
