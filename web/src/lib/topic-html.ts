export const DESIGN_TOPIC_ID = '_design'

export function topicHtmlApiPath(topicId: string): string {
  return `/api/ui/topics/${encodeURIComponent(topicId)}/html`
}

export function isDesignTopicId(topicId: string): boolean {
  return topicId === DESIGN_TOPIC_ID
}
