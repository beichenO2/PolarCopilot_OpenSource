import { describe, expect, it } from 'vitest'
import {
  formatAfkSummaryLine,
  formatAfkTaskStatusLabel,
  needsHumanReview,
  pickPrimaryAfkSummary,
} from '../rr-afk'
import type { RrAfkStatus, RrAfkSummary } from '../../types/rr'

function makeSummary(overrides: Partial<RrAfkSummary> = {}): RrAfkSummary {
  return {
    task_id: 'demo-task',
    status: 'RUNNING',
    master_session_id: 'sess-1',
    current_unit: 'U1',
    plan_revision: 2,
    loop: 3,
    allowlist: [],
    permission_request: null,
    last_command: null,
    last_verification: null,
    human_action_hint: null,
    updated_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

function makeStatus(overrides: Partial<RrAfkStatus> = {}): RrAfkStatus {
  return {
    ok: true,
    active: true,
    paused: false,
    done: false,
    maxLoops: 40,
    loopCount: 3,
    taskDir: '/tmp/demo',
    taskId: 'primary-task',
    todo: { total: 2, pending: 1, done: 1, pendingItems: ['next item'] },
    criteria: { count: 1, summary: ['npm test'] },
    orchestrator: {
      enabled: true,
      running: true,
      serviceStatus: 'running',
      masterSessionId: 'sess-1',
      lastAction: null,
      lastInjectAt: null,
      lastSessionId: null,
    },
    projectRoot: '/tmp/demo',
    health: {
      ok: true,
      enabled: true,
      afkActive: true,
      loopCount: 3,
      lastAction: null,
    },
    summaries: [makeSummary({ task_id: 'primary-task' })],
    index: { active_tasks: ['primary-task'], updated_at: '2026-07-30T00:00:00.000Z' },
    ...overrides,
  }
}

describe('rr-afk helpers', () => {
  it('pickPrimaryAfkSummary prefers status.taskId match', () => {
    const status = makeStatus({
      taskId: 'task-b',
      summaries: [
        makeSummary({ task_id: 'task-a' }),
        makeSummary({ task_id: 'task-b', status: 'READY' }),
      ],
      index: { active_tasks: ['task-a', 'task-b'], updated_at: '2026-07-30T00:00:00.000Z' },
    })

    expect(pickPrimaryAfkSummary(status)?.task_id).toBe('task-b')
  })

  it('needsHumanReview is true only for NEEDS_HUMAN with permission_request', () => {
    expect(needsHumanReview(makeSummary({ status: 'NEEDS_HUMAN', permission_request: null }))).toBe(false)
    expect(needsHumanReview(makeSummary({
      status: 'NEEDS_HUMAN',
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U11',
        plan_revision: 1,
        paths: ['tests/a.test.ts'],
      },
    }))).toBe(true)
  })

  it('formatAfkSummaryLine includes status, unit, revision, and loop', () => {
    expect(formatAfkSummaryLine(makeSummary())).toBe('demo-task · 运行中 · unit U1 · rev 2 · loop 3')
    expect(formatAfkTaskStatusLabel('NEEDS_HUMAN')).toBe('需人工')
  })
})
