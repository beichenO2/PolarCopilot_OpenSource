import { describe, expect, it } from 'vitest'
import {
  buildXjSessionFamilyRequest,
  buildXjLaunchPrompt,
  DEFAULT_XJ_AGENT_NAME,
  DEFAULT_XJ_AGENT_ROLE,
  getXjAgentFamily,
  getXjTaskTargetId,
  statusTone,
  statusLabel,
  shouldNotifyXj,
} from '../xj'
import type { XjSession } from '../../types/xj'

describe('XJ presentation helpers', () => {
  it('maps persistent session states to distinct labels and tones', () => {
    expect(statusLabel('waiting')).toBe('等待消息')
    expect(statusLabel('pending')).toBe('有新消息')
    expect(statusLabel('connecting')).toBe('连接中')
    expect(statusTone('online')).toContain('green')
    expect(statusTone('pending')).toContain('yellow')
  })

  it('notifies only for unseen assistant messages', () => {
    expect(shouldNotifyXj({ id: '1', role: 'assistant' }, new Set())).toBe(true)
    expect(shouldNotifyXj({ id: '1', role: 'user' }, new Set())).toBe(false)
    expect(shouldNotifyXj({ id: '1', role: 'assistant' }, new Set(['1']))).toBe(false)
  })

  it('builds an original-compatible launchId prompt with both requested modes', () => {
    const prompt = buildXjLaunchPrompt({
      launchId: 'xjlaunch-1784831456675-2f32d105',
      name: DEFAULT_XJ_AGENT_NAME,
      role: DEFAULT_XJ_AGENT_ROLE,
      modes: ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'],
      agentSlot: 'main',
    })

    expect(prompt).toContain('launchId「xjlaunch-1784831456675-2f32d105」')
    expect(prompt).toContain('名称「通用 Agent」')
    expect(prompt).toContain('role 使用「general-purpose」')
    expect(prompt).toContain('register_session 的原生参数就是 launchId')
    expect(prompt).toContain('不要转换字段')
    expect(prompt).toContain('夜晚自动化挂机任务')
    expect(prompt).toContain('AI 破甲（道德经Max）')
    expect(prompt).toContain('reply_message')
    expect(prompt).toContain('suggestions:string[]')
    expect(prompt).toContain('wait_message')
    expect(prompt).toContain('list_subagents')
    expect(prompt).toContain('dispatch_subagent_task')
    expect(prompt).toContain('一条用户消息就是一份完整工作单')
    expect(prompt).toContain('不得在任务中途停下来等待确认')
    expect(prompt).toContain('两个子 Agent')
    expect(prompt).toContain('所有 TODO 清零')
    expect(prompt).toContain('只允许在整项任务完成后')
    expect(prompt).not.toContain('client_key')
    expect(prompt).not.toContain('资深全栈架构师')
    expect(prompt).not.toContain('fullstack-architect')
  })

  it('builds the fixed one-main-two-subagent request used by the plus button', () => {
    expect(buildXjSessionFamilyRequest('xjlaunch-one-shot', 'XJ · 2026/7/24 12:00:00')).toEqual({
      launchId: 'xjlaunch-one-shot',
      name: '通用 Agent',
      role: 'general-purpose',
      title: 'XJ · 2026/7/24 12:00:00',
      modes: ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'],
      subagent_count: 2,
    })
  })

  it('builds a child prompt that receives delegated work without dispatching descendants', () => {
    const prompt = buildXjLaunchPrompt({
      launchId: 'xjlaunch-child-1',
      name: '子 Agent 1',
      role: DEFAULT_XJ_AGENT_ROLE,
      modes: ['夜晚自动化挂机任务'],
      agentSlot: 'subagent-1',
      parentSessionId: 'xj-mcp-agent-00000000-0000-5000-a000-000000000000',
    })

    expect(prompt).toContain('子 Agent 1')
    expect(prompt).toContain('父会话')
    expect(prompt).toContain('回复会自动回流主 Agent')
    expect(prompt).toContain('不得返回半成品')
    expect(prompt).not.toContain('dispatch_subagent_task')
  })

  it('resolves the same 1+2 family when a child session is selected', () => {
    const base = {
      clientKey: 'key', title: 'task', status: 'online' as const,
      createdAt: '', updatedAt: '', lastSeenAt: '', reconnectUntil: '', pendingCount: 0, modes: [],
    }
    const sessions: XjSession[] = [
      { ...base, id: 'main', launchId: 'main-launch', agentSlot: 'main' },
      { ...base, id: 'child-1', launchId: 'child-launch-1', agentSlot: 'subagent-1', parentSessionId: 'main' },
      { ...base, id: 'child-2', launchId: 'child-launch-2', agentSlot: 'subagent-2', parentSessionId: 'main' },
    ]

    const family = getXjAgentFamily(sessions, 'child-1')
    expect(family?.main.id).toBe('main')
    expect(family?.subagents.map((session) => session.id)).toEqual(['child-1', 'child-2'])
    expect(getXjTaskTargetId(sessions, 'child-1')).toBe('main')
    expect(getXjTaskTargetId(sessions, 'main')).toBe('main')
  })
})
