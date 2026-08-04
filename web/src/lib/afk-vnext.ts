import { api } from './api'

export type AfkVnextTask = {
  task_id: string
  goal: string
  project_root: string
  surface: string
  status: string
  mode: string
  updated_at: string
}

export async function fetchAfkVnextTasks() {
  return api.rr.afkVnextTasks()
}

export async function createAfkVnextTask(body: {
  goal: string
  projectRoot: string
  mode?: 'start' | 'solo'
}) {
  return api.rr.afkVnextCreate(body)
}

export async function fetchCompletion(taskId: string) {
  return api.rr.afkVnextCompletion(taskId)
}

/** Primary UI fields — sessionId/native handles stay in diagnostics. */
export function taskCardModel(task: AfkVnextTask) {
  return {
    id: task.task_id,
    goal: task.goal,
    phase: task.status,
    surface: task.surface,
    updatedAt: task.updated_at,
  }
}
