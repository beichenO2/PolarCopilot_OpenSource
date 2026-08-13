import type { RrAfkStatus, RrAfkSummary, RrAfkTaskStatus } from '../types/rr'

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
