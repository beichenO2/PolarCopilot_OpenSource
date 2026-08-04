import { appendEvent, readState, readSummary, writeState } from './store.js';

export interface RrAfkGrantResult {
  taskId: string;
  status: string;
  grantedPaths: string[];
  usesRemaining: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function grantTemporaryPaths(
  taskId: string,
  paths: string[],
  grantedBy = 'rr-human',
): RrAfkGrantResult {
  const summary = readSummary(taskId);
  if (!summary) throw new Error('afk_task_not_found');

  const state = readState(taskId);
  if (!state) throw new Error('afk_task_not_found');

  if (summary.status !== 'NEEDS_HUMAN' || !summary.permission_request) {
    throw new Error('permission_not_requested');
  }

  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 64) {
    throw new Error('invalid_permission_paths');
  }

  const requested = summary.permission_request.paths;
  const grantedPaths = [...new Set(paths)];
  if (grantedPaths.some((path) => typeof path !== 'string' || !requested.includes(path))) {
    throw new Error('invalid_permission_paths');
  }

  const nextAllowlist = [...new Set([...state.allowlist, ...grantedPaths])];
  const nextStatus = state.status === 'NEEDS_HUMAN' ? 'READY' : state.status;
  const timestamp = nowIso();

  writeState(taskId, {
    ...state,
    status: nextStatus,
    allowlist: nextAllowlist,
    permission_request: null,
    human_action_hint: null,
    updated_at: timestamp,
  });

  appendEvent(taskId, {
    at: timestamp,
    kind: 'temporary_paths_granted',
    detail: { paths: grantedPaths, grantedBy, uses_remaining: 1 },
  });

  const updated = readSummary(taskId)!;
  return {
    taskId,
    status: updated.status,
    grantedPaths,
    usesRemaining: 1,
  };
}
