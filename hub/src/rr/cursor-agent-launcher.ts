import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { defaultRrWorkspace, resolveCursorBin } from './cursor-spawn.js';

interface SpawnState {
  sessionId: string;
  name: string;
  launchId?: string;
  workspace: string;
  headless?: boolean;
  prompt: string;
}

function loadState(): SpawnState {
  const sessionId = process.env.RR_CURSOR_SESSION_ID;
  if (!sessionId) {
    console.error('RR_CURSOR_SESSION_ID is required');
    process.exit(1);
  }
  const dataRoot = process.env.RR_DATA_ROOT ?? join(homedir(), '.rr-cursor', 'chat');
  const statePath = join(dataRoot, 'spawn-state', `${sessionId}.json`);
  return JSON.parse(readFileSync(statePath, 'utf8')) as SpawnState;
}

const state = loadState();
const cursorBin = resolveCursorBin();
if (!cursorBin) {
  console.error('cursor_cli_not_found');
  process.exit(1);
}

const workspace = defaultRrWorkspace(state.workspace);
const args = ['agent', '--workspace', workspace, '--approve-mcps', '--trust'];
if (state.headless) {
  args.push('-p', '--print', '--force');
}
args.push(state.prompt);

const child = spawn(cursorBin, args, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
