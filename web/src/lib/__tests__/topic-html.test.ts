import { describe, expect, it } from 'vitest'
import { DESIGN_TOPIC_ID, isDesignTopicId, topicHtmlApiPath } from '../topic-html'

describe('topicHtmlApiPath', () => {
  it('builds path for _design topic', () => {
    expect(topicHtmlApiPath('_design')).toBe('/api/ui/topics/_design/html')
  })

  it('encodes spaces in topic id', () => {
    expect(topicHtmlApiPath('a b')).toBe('/api/ui/topics/a%20b/html')
  })
})

describe('isDesignTopicId', () => {
  it('returns true for _design', () => {
    expect(isDesignTopicId('_design')).toBe(true)
    expect(DESIGN_TOPIC_ID).toBe('_design')
  })

  it('returns false for zustand topic ids', () => {
    expect(isDesignTopicId('topic-1')).toBe(false)
  })
})
