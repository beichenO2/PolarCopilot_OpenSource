import { describe, expect, it } from 'vitest'
import {
  assembleThread,
  buildCenterThread,
  isAtLiveEdge,
  pendingScrollTargetId,
  shouldRenderAgentBubble,
} from '../prompt-thread'
import type { ThreadMessage } from '../prompt-thread'
import type { Prompt } from '../../types/hub'

function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  return {
    id: 'p1',
    prompt: 'Agent question',
    options: [],
    agent_id: 'agent-a',
    display_name: null,
    created_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  }
}

describe('assembleThread', () => {
  it('orders prompts by created_at ascending', () => {
    const prompts: Prompt[] = [
      makePrompt({
        id: 'later',
        prompt: 'Second',
        created_at: '2026-08-13T12:00:00.000Z',
      }),
      makePrompt({
        id: 'earlier',
        prompt: 'First',
        created_at: '2026-08-13T10:00:00.000Z',
      }),
    ]

    const thread = assembleThread('agent-a', prompts)

    expect(thread.agent_id).toBe('agent-a')
    expect(thread.messages.map((m) => m.prompt_id)).toEqual(['earlier', 'earlier', 'later', 'later'])
    expect(thread.messages[0]).toMatchObject({ prompt_id: 'earlier', role: 'agent', text: 'First' })
    expect(thread.messages[2]).toMatchObject({ prompt_id: 'later', role: 'agent', text: 'Second' })
  })

  it('adds user bubble when answered and pending when unanswered', () => {
    const prompts: Prompt[] = [
      makePrompt({
        id: 'answered',
        answered: true,
        answer: 'My reply',
        answered_at: '2026-08-13T10:05:00.000Z',
      }),
      makePrompt({
        id: 'open',
        options: ['Yes', { id: 'no', label: 'No' }],
      }),
    ]

    const thread = assembleThread('agent-a', prompts)

    const answeredUser = thread.messages.find((m) => m.id === 'answered:user')
    expect(answeredUser).toMatchObject({
      role: 'user',
      text: 'My reply',
      created_at: '2026-08-13T10:05:00.000Z',
    })
    expect(thread.messages.some((m) => m.id === 'answered:pending')).toBe(false)

    const pending = thread.messages.find((m) => m.id === 'open:pending')
    expect(pending).toMatchObject({
      role: 'pending',
      text: '待你答',
      options: ['Yes', 'No'],
    })
    expect(thread.messages.some((m) => m.id === 'open:user')).toBe(false)
  })

  it('filters out prompts for other agents', () => {
    const prompts: Prompt[] = [
      makePrompt({ id: 'mine', agent_id: 'agent-a' }),
      makePrompt({ id: 'theirs', agent_id: 'agent-b', prompt: 'Other agent' }),
    ]

    const thread = assembleThread('agent-a', prompts)

    expect(thread.messages.every((m) => m.prompt_id === 'mine')).toBe(true)
    expect(thread.messages.some((m) => m.prompt_id === 'theirs')).toBe(false)
  })

  it('extracts png attachment from agent text', () => {
    const prompts: Prompt[] = [
      makePrompt({
        id: 'shot',
        prompt: 'Review screenshot at /tmp/evidence.png please',
      }),
    ]

    const thread = assembleThread('agent-a', prompts)
    const agent = thread.messages.find((m) => m.id === 'shot:agent')

    expect(agent?.attachments).toEqual([
      { kind: 'image', href: '/tmp/evidence.png', title: 'evidence.png' },
    ])
  })
})

describe('shouldRenderAgentBubble', () => {
  const agentMsg: ThreadMessage = {
    id: 'p1:agent',
    prompt_id: 'p1',
    role: 'agent',
    text: 'Question',
    created_at: '2026-08-13T10:00:00.000Z',
    attachments: [],
  }

  it('returns true for agent when no pending shares prompt_id', () => {
    const messages: ThreadMessage[] = [
      agentMsg,
      {
        id: 'p2:pending',
        prompt_id: 'p2',
        role: 'pending',
        text: '待你答',
        created_at: '2026-08-13T10:01:00.000Z',
        attachments: [],
      },
    ]
    expect(shouldRenderAgentBubble(messages, agentMsg)).toBe(true)
  })

  it('returns false for agent when pending shares prompt_id', () => {
    const messages: ThreadMessage[] = [
      agentMsg,
      {
        id: 'p1:pending',
        prompt_id: 'p1',
        role: 'pending',
        text: '待你答',
        created_at: '2026-08-13T10:01:00.000Z',
        attachments: [],
      },
    ]
    expect(shouldRenderAgentBubble(messages, agentMsg)).toBe(false)
  })

  it('returns false for non-agent messages', () => {
    const userMsg: ThreadMessage = {
      id: 'p1:user',
      prompt_id: 'p1',
      role: 'user',
      text: 'Reply',
      created_at: '2026-08-13T10:05:00.000Z',
      attachments: [],
    }
    expect(shouldRenderAgentBubble([agentMsg, userMsg], userMsg)).toBe(false)
  })
})

describe('isAtLiveEdge', () => {
  it('returns true when bottom gap is within default 100px threshold', () => {
    expect(isAtLiveEdge(0)).toBe(true)
    expect(isAtLiveEdge(50)).toBe(true)
    expect(isAtLiveEdge(100)).toBe(true)
  })

  it('returns false when bottom gap exceeds threshold', () => {
    expect(isAtLiveEdge(101)).toBe(false)
    expect(isAtLiveEdge(500)).toBe(false)
  })

  it('respects custom threshold', () => {
    expect(isAtLiveEdge(80, 50)).toBe(false)
    expect(isAtLiveEdge(40, 50)).toBe(true)
  })
})

describe('pendingScrollTargetId', () => {
  const pending = (promptId: string): ThreadMessage => ({
    id: `${promptId}:pending`,
    prompt_id: promptId,
    role: 'pending',
    text: '待你答',
    created_at: '2026-08-13T10:00:00.000Z',
    attachments: [],
  })

  it('returns null when no pending messages', () => {
    expect(
      pendingScrollTargetId([
        {
          id: 'p1:agent',
          prompt_id: 'p1',
          role: 'agent',
          text: 'Q',
          created_at: '2026-08-13T10:00:00.000Z',
          attachments: [],
        },
      ]),
    ).toBeNull()
  })

  it('returns the last pending prompt_id in thread order', () => {
    expect(
      pendingScrollTargetId([pending('first'), pending('second'), pending('last')]),
    ).toBe('last')
  })

  it('ignores earlier pending when a later pending exists', () => {
    const messages: ThreadMessage[] = [
      pending('a'),
      {
        id: 'b:agent',
        prompt_id: 'b',
        role: 'agent',
        text: 'Later question',
        created_at: '2026-08-13T11:00:00.000Z',
        attachments: [],
      },
      pending('b'),
    ]
    expect(pendingScrollTargetId(messages)).toBe('b')
  })
})

describe('buildCenterThread', () => {
  it('merges pending and history, deduping by id with pending priority', () => {
    const pending: Prompt[] = [
      makePrompt({
        id: 'shared',
        prompt: 'Pending version',
        answered: false,
      }),
      makePrompt({
        id: 'only-pending',
        prompt: 'Open question',
        created_at: '2026-08-13T11:00:00.000Z',
      }),
    ]
    const history: Prompt[] = [
      makePrompt({
        id: 'shared',
        prompt: 'History version',
        answered: true,
        answer: 'Old answer',
        answered_at: '2026-08-13T09:00:00.000Z',
      }),
      makePrompt({
        id: 'only-history',
        prompt: 'Done question',
        answered: true,
        answer: 'Done',
        answered_at: '2026-08-13T08:00:00.000Z',
        created_at: '2026-08-13T08:00:00.000Z',
      }),
    ]

    const thread = buildCenterThread('agent-a', pending, history)

    expect(thread.messages.some((m) => m.prompt_id === 'shared' && m.role === 'pending')).toBe(true)
    expect(thread.messages.some((m) => m.prompt_id === 'shared' && m.role === 'user')).toBe(false)
    expect(thread.messages.some((m) => m.prompt_id === 'only-pending')).toBe(true)
    expect(thread.messages.some((m) => m.prompt_id === 'only-history')).toBe(true)
  })

  it('filters by agentId when set', () => {
    const pending: Prompt[] = [
      makePrompt({ id: 'mine', agent_id: 'agent-a' }),
      makePrompt({ id: 'theirs', agent_id: 'agent-b', prompt: 'Other' }),
    ]

    const thread = buildCenterThread('agent-a', pending, [])

    expect(thread.agent_id).toBe('agent-a')
    expect(thread.messages.every((m) => m.prompt_id === 'mine')).toBe(true)
  })

  it('includes all agents when agentId is null', () => {
    const pending: Prompt[] = [
      makePrompt({ id: 'a1', agent_id: 'agent-a', prompt: 'From A' }),
      makePrompt({
        id: 'b1',
        agent_id: 'agent-b',
        prompt: 'From B',
        created_at: '2026-08-13T11:00:00.000Z',
      }),
    ]

    const thread = buildCenterThread(null, pending, [])

    expect(thread.agent_id).toBe('*')
    expect(thread.messages.map((m) => m.prompt_id)).toEqual(
      expect.arrayContaining(['a1', 'a1', 'b1', 'b1']),
    )
  })

  it('orders merged prompts by created_at ascending', () => {
    const pending: Prompt[] = [
      makePrompt({
        id: 'later',
        prompt: 'Later',
        created_at: '2026-08-13T12:00:00.000Z',
      }),
    ]
    const history: Prompt[] = [
      makePrompt({
        id: 'earlier',
        prompt: 'Earlier',
        answered: true,
        answer: 'ok',
        answered_at: '2026-08-13T10:05:00.000Z',
        created_at: '2026-08-13T10:00:00.000Z',
      }),
    ]

    const thread = buildCenterThread('agent-a', pending, history)

    expect(thread.messages[0]).toMatchObject({ prompt_id: 'earlier', role: 'agent' })
    expect(thread.messages[2]).toMatchObject({ prompt_id: 'later', role: 'agent' })
  })
})
