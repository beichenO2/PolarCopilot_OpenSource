import { spawnSync } from 'node:child_process';
import { killCursorAgent } from './cursor-spawn.js';
import { listManagedRrCursorAgentPids } from './polar-process-client.js';

export interface OrphanSweepResult {
  scanned: number[];
  managed: number[];
  killed: number[];
  errors: string[];
}

export function listCursorAgentPids(): number[] {
  const result = spawnSync('ps', ['aux'], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) return [];

  const pids = new Set<number>();
  for (const line of result.stdout.split('\n')) {
    if (!line.includes('cursor-agent')) continue;
    if (line.includes('grep')) continue;
    const match = line.trim().match(/^\S+\s+(\d+)\s+/);
    if (match) pids.add(Number(match[1]));
  }
  return [...pids].sort((a, b) => a - b);
}

export async function sweepOrphanCursorAgents(extraManagedPids: number[] = []): Promise<OrphanSweepResult> {
  const scanned = listCursorAgentPids();
  const managed = new Set<number>([
    ...(await listManagedRrCursorAgentPids().catch(() => new Set<number>())),
    ...extraManagedPids.filter((pid) => Number.isInteger(pid) && pid > 0),
  ]);

  const killed: number[] = [];
  const errors: string[] = [];

  for (const pid of scanned) {
    if (managed.has(pid)) continue;
    const ok = killCursorAgent(pid);
    if (ok) killed.push(pid);
    else errors.push(`failed_to_kill:${pid}`);
  }

  if (killed.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    for (const pid of killed) {
      if (listCursorAgentPids().includes(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  }

  return {
    scanned,
    managed: [...managed].sort((a, b) => a - b),
    killed,
    errors,
  };
}
