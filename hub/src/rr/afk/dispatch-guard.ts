import { readSummary } from './store.js';
import type { RrAfkMode, RrAfkSummary } from './types.js';
import { readAllowNewSubagents } from '../orchestrator/config.js';

export const AFK_MODE_GO_FORBIDS_DISPATCH = 'afk_mode_go_forbids_dispatch';
export const AFK_MODE_GO_FORBIDS_LIST_SUBAGENTS = 'afk_mode_go_forbids_list_subagents';

export interface SessionAfkBinding {
  sessionId: string;
  afkTaskId?: string | null;
  ownerTaskId?: string | null;
}

/** Resolve the AFK task id that owns a session (master or delegated). */
export function resolveSessionAfkTaskId(session: SessionAfkBinding | null | undefined): string | null {
  if (!session) return null;
  const taskId = session.afkTaskId ?? session.ownerTaskId;
  if (!taskId || !String(taskId).trim()) return null;
  return String(taskId).trim();
}

export function readSessionAfkSummary(session: SessionAfkBinding | null | undefined): RrAfkSummary | null {
  const taskId = resolveSessionAfkTaskId(session);
  if (!taskId) return null;
  return readSummary(taskId);
}

export function sessionAfkMode(session: SessionAfkBinding | null | undefined): RrAfkMode | undefined {
  return readSessionAfkSummary(session)?.mode;
}

/**
 * Hard gate for MCP/HTTP subagent dispatch.
 * mode=go tasks must never open a subagent pool via dispatch.
 */
export function assertCanDispatchSubagent(session: SessionAfkBinding | null | undefined): void {
  if (sessionAfkMode(session) === 'go') {
    throw new Error(AFK_MODE_GO_FORBIDS_DISPATCH);
  }
}

/** Optional hard gate aligned with go inject text (list_subagents forbidden). */
export function assertCanListSubagents(session: SessionAfkBinding | null | undefined): void {
  if (sessionAfkMode(session) === 'go') {
    throw new Error(AFK_MODE_GO_FORBIDS_LIST_SUBAGENTS);
  }
}

/**
 * Effective allow-new-subagents for a task.
 * go always false (task-scoped); otherwise task override if set, else global panel config.
 */
export function effectiveAllowNewSubagents(
  summary: Pick<RrAfkSummary, 'mode' | 'allow_new_subagents'> | null | undefined,
  globalAllow: boolean = readAllowNewSubagents(),
): boolean {
  if (!summary) return globalAllow;
  if (summary.mode === 'go') return false;
  if (typeof summary.allow_new_subagents === 'boolean') return summary.allow_new_subagents;
  return globalAllow;
}

export function effectiveAllowNewSubagentsForSession(
  session: SessionAfkBinding | null | undefined,
  globalAllow: boolean = readAllowNewSubagents(),
): boolean {
  return effectiveAllowNewSubagents(readSessionAfkSummary(session), globalAllow);
}
