import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const ORCHESTRATOR_DIR = join(homedir(), '.rr-cursor', 'orchestrator');
export const ENABLED_FLAG = join(ORCHESTRATOR_DIR, 'enabled');

export function isOrchestratorEnabled(): boolean {
  return existsSync(ENABLED_FLAG);
}

export function setOrchestratorEnabled(enabled: boolean): boolean {
  mkdirSync(ORCHESTRATOR_DIR, { recursive: true, mode: 0o700 });
  if (enabled) {
    writeFileSync(ENABLED_FLAG, `${Date.now()}\n`, 'utf8');
    return true;
  }
  if (existsSync(ENABLED_FLAG)) rmSync(ENABLED_FLAG);
  return false;
}

export function readEnabledSince(): number | null {
  if (!existsSync(ENABLED_FLAG)) return null;
  const raw = readFileSync(ENABLED_FLAG, 'utf8').trim();
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
