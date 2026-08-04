import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubagentCreationPolicyToggle } from '../RrPage'

describe('SubagentCreationPolicyToggle', () => {
  it('explains that disabling new subagents does not affect existing agents', () => {
    const html = renderToStaticMarkup(createElement(SubagentCreationPolicyToggle, {
      allowNewSubagents: false,
      busy: false,
      onToggle: () => undefined,
    }))

    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="false"')
    expect(html).toContain('禁止新 Subagent')
    expect(html).toContain('只控制之后创建的 Subagent；现有 Agent 不受影响')
  })
})
