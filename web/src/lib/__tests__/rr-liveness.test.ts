import { describe, expect, it } from 'vitest'
import {
  isLiveAvailability,
  isLiveSession,
  partitionSessionsByLiveness,
  partitionSubagentsByLiveness,
  sortSessionsByUrgency,
  sortSubagentsByUrgency,
} from '../rr'
import type { RrSession, RrSubagent } from '../../types/rr'

function session(partial: Partial<RrSession> & Pick<RrSession, 'sessionId' | 'createdAt'>): RrSession {
  return {
    name: 'Rr Agent',
    title: 'Test',
    role: 'general-purpose',
    lastActiveAt: partial.createdAt,
    agentStatus: 'ready',
    waiting: false,
    pendingMessages: 0,
    online: true,
    isSubagent: false,
    status: 'online',
    ...partial,
  }
}

describe('isLiveAvailability', () => {
  it('returns true for actionable subagent/session states', () => {
    expect(isLiveAvailability('idle')).toBe(true)
    expect(isLiveAvailability('busy')).toBe(true)
    expect(isLiveAvailability('working')).toBe(true)
    expect(isLiveAvailability('waiting')).toBe(true)
    expect(isLiveAvailability('online')).toBe(true)
  })

  it('returns false for offline', () => {
    expect(isLiveAvailability('offline')).toBe(false)
  })

  it('allows completed within grace window only', () => {
    const now = 100_000
    expect(isLiveAvailability('completed', { completedAt: now - 5_000, now })).toBe(true)
    expect(isLiveAvailability('completed', { completedAt: now - 20_000, now })).toBe(false)
    expect(isLiveAvailability('completed')).toBe(false)
  })
})

describe('isLiveSession', () => {
  it('treats offline or not-online sessions as not live', () => {
    expect(isLiveSession(session({ sessionId: 'a', createdAt: 1, status: 'offline', online: false }))).toBe(false)
    expect(isLiveSession(session({ sessionId: 'b', createdAt: 1, status: 'online', online: false }))).toBe(false)
  })

  it('treats online/waiting/working as live', () => {
    expect(isLiveSession(session({ sessionId: 'c', createdAt: 1, status: 'working' }))).toBe(true)
    expect(isLiveSession(session({ sessionId: 'd', createdAt: 1, status: 'waiting' }))).toBe(true)
  })
})

describe('partitionSessionsByLiveness', () => {
  it('splits live and offline sessions', () => {
    const live1 = session({ sessionId: 'live1', createdAt: 1, status: 'working' })
    const live2 = session({ sessionId: 'live2', createdAt: 2, status: 'waiting' })
    const off = session({ sessionId: 'off', createdAt: 3, status: 'offline', online: false })
    const result = partitionSessionsByLiveness([live1, off, live2])
    expect(result.live.map((s) => s.sessionId)).toEqual(['live1', 'live2'])
    expect(result.offline.map((s) => s.sessionId)).toEqual(['off'])
  })
})

function subagent(partial: Partial<RrSubagent> & Pick<RrSubagent, 'sessionId'>): RrSubagent {
  return {
    name: 'Sub Agent',
    availability: 'idle',
    agentStatus: 'ready',
    lastActiveAt: 1,
    ...partial,
  }
}

describe('partitionSubagentsByLiveness', () => {
  it('splits idle/busy from offline subagents', () => {
    const idle = subagent({ sessionId: 'idle', availability: 'idle' })
    const busy = subagent({ sessionId: 'busy', availability: 'busy' })
    const off = subagent({ sessionId: 'off', availability: 'offline' })
    const result = partitionSubagentsByLiveness([idle, off, busy])
    expect(result.live.map((a) => a.sessionId)).toEqual(['idle', 'busy'])
    expect(result.offline.map((a) => a.sessionId)).toEqual(['off'])
  })

  it('preserves urgency sort within live partition', () => {
    const idle = subagent({ sessionId: 'idle', availability: 'idle', lastActiveAt: 2 })
    const busy = subagent({ sessionId: 'busy', availability: 'busy', lastActiveAt: 1 })
    const off = subagent({ sessionId: 'off', availability: 'offline' })
    const { live } = partitionSubagentsByLiveness([idle, off, busy])
    expect(sortSubagentsByUrgency(live).map((a) => a.sessionId)).toEqual(['busy', 'idle'])
  })
})

describe('sortSessionsByUrgency', () => {
  it('orders working before waiting before idle/online', () => {
    const working = session({ sessionId: 'w', createdAt: 1, status: 'working' })
    const waiting = session({ sessionId: 'wa', createdAt: 2, status: 'waiting' })
    const online = session({ sessionId: 'o', createdAt: 3, status: 'online' })
    const sorted = sortSessionsByUrgency([online, waiting, working])
    expect(sorted.map((s) => s.sessionId)).toEqual(['w', 'wa', 'o'])
  })

  it('prioritizes pending inbox over plain online', () => {
    const inbox = session({ sessionId: 'inbox', createdAt: 1, status: 'online', pendingMessages: 2 })
    const plain = session({ sessionId: 'plain', createdAt: 2, status: 'online' })
    expect(sortSessionsByUrgency([plain, inbox]).map((s) => s.sessionId)).toEqual(['inbox', 'plain'])
  })
})
