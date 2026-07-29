import type { RrMessage, RrSession, RrSubagentView } from '../types.js';
import type { HubClientOptions } from './types.js';

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/$/, '')}${path}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Hub ${response.status} ${url}: ${body.slice(0, 300)}`);
  }
  return response.json() as Promise<T>;
}

export class RrHubClient {
  readonly hubUrl: string;

  constructor(options: HubClientOptions) {
    this.hubUrl = options.hubUrl.replace(/\/$/, '');
  }

  async health(): Promise<{ status: string }> {
    return request(joinUrl(this.hubUrl, '/api/health'));
  }

  async listSessions(): Promise<RrSession[]> {
    const payload = await request<{ sessions: RrSession[] }>(joinUrl(this.hubUrl, '/api/ui/rr/sessions'));
    return payload.sessions;
  }

  async sessionDetail(sessionId: string): Promise<{ session: RrSession; history: RrMessage[] }> {
    return request(joinUrl(this.hubUrl, `/api/ui/rr/sessions/${encodeURIComponent(sessionId)}`));
  }

  async listSubagents(sessionId?: string): Promise<RrSubagentView[]> {
    const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    const payload = await request<{ subagents: RrSubagentView[] }>(joinUrl(this.hubUrl, `/api/ui/rr/subagents${query}`));
    return payload.subagents;
  }

  async injectMessage(sessionId: string, content: string): Promise<RrMessage> {
    const payload = await request<{ message: RrMessage }>(joinUrl(this.hubUrl, `/api/ui/rr/sessions/${encodeURIComponent(sessionId)}/messages`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return payload.message;
  }

  async dispatchTask(masterSessionId: string, targetSessionId: string, content: string): Promise<{ taskId: string }> {
    const payload = await request<{ task: { taskId: string } }>(
      joinUrl(this.hubUrl, `/api/ui/rr/sessions/${encodeURIComponent(masterSessionId)}/dispatch`),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSessionId, content }),
      },
    );
    return { taskId: payload.task.taskId };
  }

  stream(onEvent: () => void): { close: () => void } {
    const url = joinUrl(this.hubUrl, '/api/ui/rr/stream');
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        while (buffer.includes('\n\n')) {
          const split = buffer.indexOf('\n\n');
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (block.includes('event: rr_store_changed') || block.includes('event: rr_message_created')) {
            onEvent();
          }
        }
      }
    })().catch(() => undefined);
    return { close: () => controller.abort() };
  }
}
