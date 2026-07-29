import { describe, expect, it } from 'vitest'
import { buildRrSessionForest } from '../rr'
import type { RrSession } from '../../types/rr'

function session(partial: Partial<RrSession> & Pick<RrSession, 'sessionId' | 'title' | 'isSubagent' | 'createdAt'>): RrSession {
  return {
    name: 'Rr Agent',
    role: 'general-purpose',
    lastActiveAt: partial.createdAt,
    agentStatus: 'ready',
    waiting: false,
    pendingMessages: 0,
    online: true,
    status: 'online',
    ...partial,
  }
}

describe('buildRrSessionForest', () => {
  it('groups 主/子 by title stamp and keeps default tree shape', () => {
    const stamp = '15:04:05-ab12'
    const forest = buildRrSessionForest([
      session({ sessionId: 'm1', title: `主 · ${stamp}`, isSubagent: false, createdAt: 1000, name: 'Rr Agent · 主' }),
      session({ sessionId: 's1', title: `子1 · ${stamp}`, isSubagent: true, createdAt: 1100, name: 'Rr Agent · 子1' }),
      session({ sessionId: 's2', title: `子2 · ${stamp}`, isSubagent: true, createdAt: 1200, name: 'Rr Agent · 子2' }),
      session({ sessionId: 'solo', title: '独立会话', isSubagent: false, createdAt: 900 }),
    ])

    expect(forest.groups).toHaveLength(1)
    expect(forest.groups[0]!.main.sessionId).toBe('m1')
    expect(forest.groups[0]!.children.map((c) => c.sessionId)).toEqual(['s1', 's2'])
    expect(forest.singles.map((s) => s.sessionId)).toEqual(['solo'])
  })

  it('does not attach sub with mismatched stamp', () => {
    const forest = buildRrSessionForest([
      session({ sessionId: 'm1', title: '主 · A', isSubagent: false, createdAt: 1000 }),
      session({ sessionId: 's1', title: '子1 · B', isSubagent: true, createdAt: 1100 }),
    ])

    expect(forest.groups[0]!.children).toHaveLength(0)
    expect(forest.singles.map((s) => s.sessionId)).toContain('s1')
  })

  it('falls back to name + time window when titles diverge', () => {
    const forest = buildRrSessionForest([
      session({ sessionId: 'm1', title: '架构设计', isSubagent: false, createdAt: 1000, name: 'Rr Agent · 主' }),
      session({ sessionId: 's1', title: '侦查', isSubagent: true, createdAt: 1500, name: 'Rr Agent · 子1' }),
      session({ sessionId: 's2', title: '实现', isSubagent: true, createdAt: 2000, name: 'Rr Agent · 子2' }),
    ])

    expect(forest.groups).toHaveLength(1)
    expect(forest.groups[0]!.children.map((c) => c.sessionId)).toEqual(['s1', 's2'])
    expect(forest.singles).toHaveLength(0)
  })

  it('still nests when Agent rewrote titles and cleared isSubagent', () => {
    // 贴近线上：子先写入、主稍晚；title 被改写；isSubagent 变 false，仅 name 保留 · 主/· 子N
    const forest = buildRrSessionForest([
      session({ sessionId: 's2', title: 'Rr子2待命', isSubagent: false, createdAt: 2264, name: 'Rr Agent · 子2' }),
      session({ sessionId: 's1', title: 'Rr子Agent·子1', isSubagent: false, createdAt: 3312, name: 'Rr Agent · 子1' }),
      session({ sessionId: 'm1', title: 'Rr主会话', isSubagent: false, createdAt: 5470, name: 'Rr Agent · 主' }),
      session({ sessionId: 'solo', title: '自我介绍', isSubagent: false, createdAt: 54, name: 'Rr Agent' }),
    ])

    expect(forest.groups).toHaveLength(1)
    expect(forest.groups[0]!.main.sessionId).toBe('m1')
    expect(forest.groups[0]!.children.map((c) => c.sessionId).sort()).toEqual(['s1', 's2'])
    expect(forest.singles.map((s) => s.sessionId)).toEqual(['solo'])
  })

  it('keeps creation order even when lastActiveAt is newer on an older session', () => {
    const forest = buildRrSessionForest([
      session({ sessionId: 'older', title: '旧会话', isSubagent: false, createdAt: 1000, lastActiveAt: 9000 }),
      session({ sessionId: 'newer', title: '新会话', isSubagent: false, createdAt: 2000, lastActiveAt: 2100 }),
    ])
    expect(forest.singles.map((s) => s.sessionId)).toEqual(['newer', 'older'])
  })
})
