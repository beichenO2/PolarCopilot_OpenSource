import type { RrAfkActiveTaskStatus, RrAfkStatus, RrAfkSummary, RrAfkTaskStatus } from '../types/rr'

/** All active task IDs from index (SSoT) with activeTasks fallback. */
export function listActiveAfkTaskIds(status: RrAfkStatus | null): string[] {
  if (!status) return []
  const fromIndex = status.index?.active_tasks ?? []
  if (fromIndex.length > 0) return [...fromIndex]
  return (status.activeTasks ?? []).map((item) => item.taskId)
}

/** Hub-normalized active task rows when present. */
export function listActiveAfkTasks(status: RrAfkStatus | null): RrAfkActiveTaskStatus[] {
  if (!status?.activeTasks?.length) return []
  return status.activeTasks
}

/** Summaries for every concurrently active task (chip/list UI). */
export function listActiveAfkSummaries(status: RrAfkStatus | null): RrAfkSummary[] {
  if (!status?.summaries?.length) return []
  const ids = new Set(listActiveAfkTaskIds(status))
  if (ids.size === 0) return status.summaries
  return status.summaries.filter((item) => ids.has(item.task_id))
}

/** NOW pane: active index tasks only. */
export function listNowAfkSummaries(status: RrAfkStatus | null): RrAfkSummary[] {
  return listActiveAfkSummaries(status)
}

/** HISTORY pane: completed or no-longer-active tasks. */
export function listHistoryAfkSummaries(status: RrAfkStatus | null): RrAfkSummary[] {
  if (!status?.summaries?.length) return []
  const activeIds = new Set(listActiveAfkTaskIds(status))
  return status.summaries.filter((item) => !activeIds.has(item.task_id) || item.status === 'DONE')
}

/** Count of concurrently active AFK tasks (fleet-10 UI). */
export function countActiveAfkTasks(status: RrAfkStatus | null): number {
  return listActiveAfkTaskIds(status).length
}

/** Short label for multi-active fleet header, e.g. "3 active". */
export function formatActiveAfkTasksLabel(status: RrAfkStatus | null): string {
  const count = countActiveAfkTasks(status)
  if (count === 0) return '0 active'
  return `${count} active`
}

export function pickPrimaryAfkSummary(status: RrAfkStatus | null): RrAfkSummary | null {
  if (!status?.summaries?.length) return null
  if (status.taskId) {
    const match = status.summaries.find((item) => item.task_id === status.taskId)
    if (match) return match
  }
  for (const taskId of status.index?.active_tasks ?? []) {
    const match = status.summaries.find((item) => item.task_id === taskId)
    if (match) return match
  }
  return status.summaries[0] ?? null
}

export function needsHumanReview(summary: RrAfkSummary | null): boolean {
  return summary?.status === 'NEEDS_HUMAN' && summary.permission_request != null
}

export function formatAfkTaskStatusLabel(status: RrAfkTaskStatus): string {
  const labels: Record<RrAfkTaskStatus, string> = {
    PLANNING: '规划中',
    READY: '就绪',
    RUNNING: '运行中',
    UNIT_DONE: '单元完成',
    READY_TO_MERGE: '待合并',
    DONE: '已完成',
    PAUSED: '已暂停',
    NEEDS_HUMAN: '需人工',
    BLOCKED: '阻塞',
  }
  return labels[status] ?? status
}

export function formatAfkSummaryLine(summary: RrAfkSummary): string {
  const parts = [
    summary.task_id,
    formatAfkTaskStatusLabel(summary.status),
  ]
  if (summary.current_unit) parts.push(`unit ${summary.current_unit}`)
  parts.push(`rev ${summary.plan_revision}`)
  parts.push(`loop ${summary.loop}`)
  return parts.join(' · ')
}
