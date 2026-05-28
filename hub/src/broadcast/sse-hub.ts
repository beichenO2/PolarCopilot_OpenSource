import type { Response } from 'express';
import type { BroadcastEvent } from '../types.js';

type Client = { agentId: string; res: Response };

export class SseHub {
  private readonly clients = new Set<Client>();

  addClient(agentId: string, res: Response): () => void {
    const client = { agentId, res };
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  broadcast(event: BroadcastEvent, shouldSend: (agentId: string, topic: string) => boolean): void {
    const chunk = `data: ${JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    })}\n\n`;
    for (const c of this.clients) {
      if (!shouldSend(c.agentId, event.topic)) continue;
      try {
        c.res.write(chunk);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
