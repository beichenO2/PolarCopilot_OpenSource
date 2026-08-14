export const DESIGN_TOPIC_ID = '_design'

export function topicHtmlApiPath(topicId: string, agentId?: string | null): string {
  const base = `/api/ui/topics/${encodeURIComponent(topicId)}/html`
  if (!agentId) return base
  return `${base}?agent_id=${encodeURIComponent(agentId)}`
}

export function isDesignTopicId(topicId: string): boolean {
  return topicId === DESIGN_TOPIC_ID
}
