import { describe, expect, it } from 'vitest'
import { sessionNeedsAttention } from '../rr'

describe('sessionNeedsAttention', () => {
  it('is false when there is no message timestamp', () => {
    expect(sessionNeedsAttention({ sessionId: 'a', lastMessageTs: 0 }, {})).toBe(false)
    expect(sessionNeedsAttention({ sessionId: 'a' }, {})).toBe(false)
  })

  it('is true when lastMessageTs is ahead of last-read watermark', () => {
    expect(sessionNeedsAttention({ sessionId: 'a', lastMessageTs: 200 }, { a: 100 })).toBe(true)
    expect(sessionNeedsAttention({ sessionId: 'a', lastMessageTs: 200 }, {})).toBe(true)
  })

  it('is false when already read', () => {
    expect(sessionNeedsAttention({ sessionId: 'a', lastMessageTs: 200 }, { a: 200 })).toBe(false)
    expect(sessionNeedsAttention({ sessionId: 'a', lastMessageTs: 200 }, { a: 300 })).toBe(false)
  })
})
