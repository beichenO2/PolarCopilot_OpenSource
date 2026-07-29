import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildRrLaunchPrompt } from './launch-prompt.js';
import {
  registerAndStartRrCursorAgent,
  rrCursorServiceId,
  stopPolarProcessService,
} from './polar-process-client.js';
import type { RrSession } from './types.js';

export interface SpawnCursorAgentInput {
  session: RrSession;
  workspace?: string;
  headless?: boolean;
  dataRoot?: string;
}

export interface SpawnCursorAgentResult {
  ok: true;
  sessionId: string;
  workspace: string;
  pid: number;
  polarProcessServiceId: string;
  mode: 'ide' | 'headless';
  cursorBin: string;
}

const CURSOR_CANDIDATES = [
  '/usr/local/bin/cursor',
  '/opt/homebrew/bin/cursor',
  resolvePath(homedir(), '.local/bin/cursor'),
  '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
];

function resolvePath(...parts: string[]): string {
  return join(...parts);
}

export function resolveCursorBin(): string | null {
  for (const candidate of [process.env.RR_CURSOR_BIN, process.env.CURSOR_BIN]) {
    if (candidate) return existsSync(candidate) ? candidate : null;
  }
  for (const candidate of CURSOR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  const which = spawnSync('which', ['cursor'], { encoding: 'utf8' });
  const found = which.stdout.trim();
  return found && existsSync(found) ? found : null;
}

export function defaultRrWorkspace(explicit?: string): string {
  const fromEnv = process.env.PC_PROJECT_DIR ?? process.env.RR_CURSOR_WORKSPACE;
  const value = explicit?.trim() || fromEnv || process.cwd();
  return resolvePath(value);
}

export function spawnStatePath(dataRoot: string, sessionId: string): string {
  return join(dataRoot, 'spawn-state', `${sessionId}.json`);
}

export function writeSpawnState(input: SpawnCursorAgentInput): { dataRoot: string; workspace: string; prompt: string } {
  const dataRoot = input.dataRoot ?? process.env.RR_DATA_ROOT ?? join(homedir(), '.rr-cursor', 'chat');
  const workspace = defaultRrWorkspace(input.workspace);
  const prompt = buildRrLaunchPrompt(input.session);
  const stateDir = join(dataRoot, 'spawn-state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(spawnStatePath(dataRoot, input.session.sessionId), `${JSON.stringify({
    sessionId: input.session.sessionId,
    name: input.session.name,
    launchId: input.session.launchId,
    workspace,
    headless: input.headless ?? false,
    prompt,
  }, null, 2)}\n`, 'utf8');
  return { dataRoot, workspace, prompt };
}

export function buildRrCursorAgentCommand(sessionId: string, dataRoot: string): string {
  return `RR_CURSOR_SESSION_ID=${sessionId} RR_DATA_ROOT=${dataRoot} bash Start/rr-cursor-agent.sh`;
}

export function killCursorAgent(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const killGroup = () => {
    try {
      process.kill(-pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  };
  const killProcess = () => {
    try {
      process.kill(pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  };
  const killed = killGroup() || killProcess();
  if (!killed) return false;
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group may already be gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* process may already be gone */ }
  }, 2_000).unref?.();
  return true;
}

export async function stopCursorAgentForSession(session: Pick<RrSession, 'sessionId' | 'cursorAgentPid' | 'polarProcessServiceId'>): Promise<void> {
  const serviceId = session.polarProcessServiceId ?? rrCursorServiceId(session.sessionId);
  await stopPolarProcessService(serviceId).catch(() => undefined);
  if (session.cursorAgentPid) {
    killCursorAgent(session.cursorAgentPid);
  }
}

export async function spawnCursorAgent(input: SpawnCursorAgentInput): Promise<SpawnCursorAgentResult> {
  const cursorBin = resolveCursorBin();
  if (!cursorBin) {
    throw new Error('cursor_cli_not_found');
  }

  const { dataRoot, workspace } = writeSpawnState(input);
  const command = buildRrCursorAgentCommand(input.session.sessionId, dataRoot);
  const started = await registerAndStartRrCursorAgent({
    sessionId: input.session.sessionId,
    name: input.session.name,
    command,
  });

  const pid = started.pid;
  if (!pid || pid <= 0) {
    throw new Error('cursor_spawn_failed');
  }

  return {
    ok: true,
    sessionId: input.session.sessionId,
    workspace,
    pid,
    polarProcessServiceId: started.id,
    mode: input.headless ? 'headless' : 'ide',
    cursorBin,
  };
}
