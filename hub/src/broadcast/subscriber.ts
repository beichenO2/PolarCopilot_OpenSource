/** In-memory topic filters per agent (empty list = all topics). */
export class EventSubscriber {
  private readonly topicsByAgent = new Map<string, string[]>();

  setSubscription(agentId: string, topics: string[]): void {
    this.topicsByAgent.set(agentId, [...topics]);
  }

  getSubscription(agentId: string): string[] {
    return this.topicsByAgent.get(agentId) ?? [];
  }

  matches(agentId: string, topic: string): boolean {
    const topics = this.topicsByAgent.get(agentId);
    if (!topics || topics.length === 0) return true;
    return topics.includes(topic);
  }
}
