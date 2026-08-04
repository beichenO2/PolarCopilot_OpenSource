import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AfkPermissionReviewCard } from '../RrPage'
import type { RrAfkSummary } from '../../types/rr'

describe('AfkPermissionReviewCard', () => {
  it('renders grant action for NEEDS_HUMAN permission requests', () => {
    const summary: RrAfkSummary = {
      task_id: 'knowlever-solo',
      status: 'NEEDS_HUMAN',
      master_session_id: 'sess-1',
      current_unit: 'U11',
      plan_revision: 1,
      loop: 2,
      allowlist: [],
      permission_request: {
        kind: 'temporary_write_paths',
        unit: 'U11',
        plan_revision: 1,
        paths: ['tests/a.test.ts'],
      },
      last_command: null,
      last_verification: null,
      human_action_hint: 'review tests path',
      updated_at: '2026-07-30T00:00:00.000Z',
    }

    const html = renderToStaticMarkup(createElement(AfkPermissionReviewCard, {
      summary,
      busy: false,
      onGrant: () => undefined,
    }))

    expect(html).toContain('需要人工审核')
    expect(html).toContain('knowlever-solo')
    expect(html).toContain('tests/a.test.ts')
    expect(html).toContain('一键授权路径')
  })
})
