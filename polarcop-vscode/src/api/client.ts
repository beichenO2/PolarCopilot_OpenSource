import * as http from 'http';
import * as https from 'https';

export interface StreamEvent {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'chunk' | 'done' | 'error';
  round?: number;
  model?: string;
  message_count?: number;
  tool?: string;
  args?: Record<string, unknown>;
  call_id?: string;
  timestamp?: string;
  result?: string;
  success?: boolean;
  duration_ms?: number;
  content?: string;
  message?: string;
}

export class PolarClawClient {
  private baseUrl: string;
  private conversationId: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  setConversationId(id: string | null): void {
    this.conversationId = id;
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  async chat(
    text: string,
    _entryType: string,
    _userId: string,
    onChunk: (chunk: string) => void,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/agent/chat/stream`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const body = JSON.stringify({
      message: text,
      ...(this.conversationId ? { conversation_id: this.conversationId } : {})
    });

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
            'Accept': 'text/event-stream',
            'X-Entry-Type': _entryType
          }
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (c) => { errBody += c.toString(); });
            res.on('end', () => {
              try {
                const parsed = JSON.parse(errBody);
                reject(new Error(parsed.error || `Server returned ${res.statusCode}`));
              } catch {
                reject(new Error(`Server returned ${res.statusCode}: ${errBody}`));
              }
            });
            return;
          }

          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let currentEvent = '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const dataStr = line.slice(6);
                try {
                  const parsed = JSON.parse(dataStr) as StreamEvent;
                  onEvent?.(parsed);
                  if (parsed.type === 'done' && parsed.content) {
                    onChunk(parsed.content);
                  }
                } catch {
                  // non-JSON SSE data, ignore
                }
                currentEvent = '';
              }
            }
          });

          res.on('end', () => resolve());
          res.on('error', (err) => reject(err));
        }
      );

      req.on('error', (err) => {
        reject(new Error(`Cannot connect to PolarClaw at ${this.baseUrl}: ${err.message}`));
      });

      req.setTimeout(600000, () => {
        req.destroy();
        reject(new Error('请求超时（10分钟）— Agent 可能在处理复杂任务。如需更长时间，请考虑拆分任务。'));
      });

      req.write(body);
      req.end();
    });
  }

  async healthCheck(): Promise<boolean> {
    const url = new URL(`${this.baseUrl}/api/status`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    return new Promise((resolve) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'GET',
          timeout: 5000
        },
        (res) => resolve(res.statusCode === 200)
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  resetConversation(): void {
    this.conversationId = null;
  }

  async listConversations(limit = 50): Promise<Array<{
    conversationId: string;
    messageCount: number;
    lastMessageAt: string;
    preview: string;
  }>> {
    return this._getJson(`/api/conversations?limit=${limit}`);
  }

  async getConversation(id: string): Promise<{
    conversationId: string;
    messages: Array<{ role: string; content: string; timestamp: string | null }>;
  }> {
    return this._getJson(`/api/conversations/${encodeURIComponent(id)}`);
  }

  private _getJson<T>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = httpModule.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(data) as T); }
            catch { reject(new Error(`Invalid JSON from ${path}`)); }
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }
}
