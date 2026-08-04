import { describe, expect, it } from 'vitest'
import { listHistoryAfkSummaries, listNowAfkSummaries } from '../rr-afk'
import type { RrAfkStatus, RrAfkSummary } from '../../types/rr'

function makeSummary(overrides: Partial<RrAfkSummary> = {}): RrAfkSummary {
  return {
    task_id: 'demo-task',
    status: 'RUNNING',
    master_session_id: 'sess-1',
    current_unit: 'U1',
    plan_revision: 1,
    loop: 1,
    allowlist: [],
    permission_request: null,
    last_command: null,
    last_verification: null,
    human_action_hint: null,
    updated_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

function makeStatus(summaries: RrAfkSummary[], activeTasks: string[]): RrAfkStatus {
  return {
    ok: true,
    active: activeTasks.length > 0,
    paused: false,
    done: false,
    maxLoops: 40,
    loopCount: 1,
    taskDir: '/tmp',
    taskId: activeTasks[0] ?? null,
    activeTasks: activeTasks.map((taskId) => ({
      taskId,
      masterSessionId: 'sess-1',
      status: 'RUNNING',
      loopCount: 1,
      maxLoops: 40,
      paused: false,
      done: false,
      projectRoot: '/tmp',
    })),
    todo: { total: 0, pending: 0, done: 0, pendingItems: [] },
    criteria: { count: 0, summary: [] },
    orchestrator: {
      enabled: true,
      running: true,
      serviceStatus: 'running',
      masterSessionId: 'sess-1',
      lastAction: null,
      lastInjectAt: null,
      lastSessionId: null,
    },
    projectRoot: '/tmp',
    health: { ok: true, enabled: true, afkActive: true, loopCount: 1, lastAction: null },
    summaries,
    index: { active_tasks: activeTasks, updated_at: '2026-07-30T00:00:00.000Z' },
  }
}

describe('AFK NOW vs HISTORY partitioning', () => {
  it('listNowAfkSummaries returns only active index tasks', () => {
    const status = makeStatus(
      [
        makeSummary({ task_id: 'active-a', status: 'RUNNING' }),
        makeSummary({ task_id: 'done-old', status: 'DONE' }),
      ],
      ['active-a'],
    )
    expect(listNowAfkSummaries(status).map((s) => s.task_id)).toEqual(['active-a'])
  })

  it('listHistoryAfkSummaries returns non-active and DONE tasks', () => {
    const status = makeStatus(
      [
        makeSummary({ task_id: 'active-a', status: 'RUNNING' }),
        makeSummary({ task_id: 'done-old', status: 'DONE' }),
        makeSummary({ task_id: 'paused-old', status: 'PAUSED' }),
      ],
      ['active-a'],
    )
    expect(listHistoryAfkSummaries(status).map((s) => s.task_id).sort()).toEqual(['done-old', 'paused-old'])
  })
})
