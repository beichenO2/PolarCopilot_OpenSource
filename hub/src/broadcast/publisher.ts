import type { HubStore } from '../persistence/store.js';
import type { BroadcastEvent } from '../types.js';
import type { SseHub } from './sse-hub.js';
import type { EventSubscriber } from './subscriber.js';

const IDEMPOTENCY_TTL_MS = 86_400_000;

export class BroadcastPublisher {
  constructor(
    private readonly store: HubStore,
    private readonly sse: SseHub,
    private readonly subscriber: EventSubscriber,
  ) {}

  publish(params: {
    sourceAgentId: string;
    topic: string;
    payload: unknown;
    idempotencyKey?: string;
  }): { event: BroadcastEvent; deduplicated: boolean } {
    if (params.idempotencyKey) {
      const cached = this.store.getIdempotencyResult(params.idempotencyKey);
      const revived = BroadcastPublisher.reviveCachedEvent(cached);
      if (revived) {
        return { event: revived, deduplicated: true };
      }
    }

    const payload = BroadcastPublisher.compressPayload(params.topic, params.payload);
    const row = this.store.appendBroadcastEvent({
      sourceAgentId: params.sourceAgentId,
      topic: params.topic,
      payload,
    });

    const event: BroadcastEvent = {
      id: row.id,
      agent_id: params.sourceAgentId,
      topic: params.topic,
      payload,
      timestamp: row.createdAt,
    };

    if (params.idempotencyKey) {
      this.store.setIdempotencyResult(
        params.idempotencyKey,
        { ...event, timestamp: event.timestamp.toISOString() },
        IDEMPOTENCY_TTL_MS,
      );
    }

    this.sse.broadcast(event, (agentId, topic) => this.subscriber.matches(agentId, topic));

    return { event, deduplicated: false };
  }

  /** Avoid huge SSE/MCP payloads — large JSON collapses to a short preview object. */
  static compressPayload(topic: string, payload: unknown): unknown {
    try {
      const s = JSON.stringify(payload);
      if (s.length <= 65536) return payload;
      return { _hub_truncated: true, topic, preview: s.slice(0, 4096), size: s.length };
    } catch {
      return { _hub_non_json: true, topic };
    }
  }

  private static reviveCachedEvent(value: unknown): BroadcastEvent | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.id !== 'string' ||
      typeof v.agent_id !== 'string' ||
      typeof v.topic !== 'string' ||
      !('payload' in v)
    ) {
      return null;
    }
    const ts = v.timestamp;
    if (typeof ts !== 'string' && !(ts instanceof Date)) return null;
    return {
      id: v.id,
      agent_id: v.agent_id,
      topic: v.topic,
      payload: v.payload,
      timestamp: ts instanceof Date ? ts : new Date(ts),
    };
  }
}
