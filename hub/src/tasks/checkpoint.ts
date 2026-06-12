import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { agentCheckpointSchema } from '../protocol/agent.js';
import type { AgentCheckpoint } from '../types.js';

export function checkpointDir(root: string): string {
  return join(resolve(root), '.planning/hub/checkpoints');
}

function safeUnderRoot(root: string, fileAbs: string): boolean {
  const base = checkpointDir(root);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return fileAbs === base || fileAbs.startsWith(prefix);
}

export function writeAgentCheckpoint(root: string, checkpoint: AgentCheckpoint): void {
  const dir = checkpointDir(root);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${checkpoint.agent_id}_${checkpoint.task_id}.json`);
  if (!safeUnderRoot(root, resolve(target))) {
    throw new Error('checkpoint_path_unsafe');
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(agentCheckpointSchema.parse(checkpoint))}\n`, 'utf8');
    renameSync(tmp, target);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function readAgentCheckpoint(root: string, agentId: string, taskId: string): AgentCheckpoint | null {
  const file = join(checkpointDir(root), `${agentId}_${taskId}.json`);
  if (!existsSync(file)) return null;
  if (!safeUnderRoot(root, resolve(file))) return null;
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return agentCheckpointSchema.parse(raw);
}
