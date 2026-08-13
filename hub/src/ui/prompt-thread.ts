import type { Express } from 'express';
import { asc, eq } from 'drizzle-orm';
import { uiPrompts, type HubDb } from '../persistence/db.js';

export type ThreadAttachment = {
  kind: 'html' | 'image' | 'pdf' | 'file';
  href: string;
  title?: string;
};

export type ThreadMessage = {
  id: string;
  prompt_id: string;
  role: 'agent' | 'user' | 'pending';
  text: string;
  created_at: string;
  options?: string[];
  attachments: ThreadAttachment[];
};

export type ThreadResponse = {
  agent_id: string;
  messages: ThreadMessage[];
};

type UiPromptRow = typeof uiPrompts.$inferSelect;

const PATH_OR_URL_RE =
  /(?:https?:\/\/[^\s)\]}>"']+|\/[^\s)\]}>"']+|(?:\.\.?\/)[^\s)\]}>"']+)/g;

function attachmentKind(href: string): ThreadAttachment['kind'] {
  const lower = href.toLowerCase().split(/[?#]/)[0] ?? href;
  if (lower.endsWith('.html')) return 'html';
  if (/\.(png|jpg|jpeg|webp|gif)$/.test(lower)) return 'image';
  if (lower.endsWith('.pdf')) return 'pdf';
  return 'file';
}

function extractAttachments(text: string): ThreadAttachment[] {
  const matches = text.match(PATH_OR_URL_RE) ?? [];
  const seen = new Set<string>();
  const attachments: ThreadAttachment[] = [];
  for (const raw of matches) {
    const href = raw.replace(/[.,;:!?)]+$/, '');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    attachments.push({ kind: attachmentKind(href), href });
  }
  return attachments;
}

function parseOptions(optionsJson: string): string[] | undefined {
  try {
    const parsed = JSON.parse(optionsJson);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(String);
    }
  } catch {
    /* ignore malformed options */
  }
  return undefined;
}

function toIso(date: Date): string {
  return date.toISOString();
}

export function buildThread(agentId: string, rows: UiPromptRow[]): ThreadResponse {
  const messages: ThreadMessage[] = [];

  for (const row of rows) {
    const options = parseOptions(row.optionsJson);
    const agentMessage: ThreadMessage = {
      id: `${row.id}:agent`,
      prompt_id: row.id,
      role: 'agent',
      text: row.prompt,
      created_at: toIso(row.createdAt),
      attachments: extractAttachments(row.prompt),
    };
    if (options) {
      agentMessage.options = options;
    }
    messages.push(agentMessage);

    if (row.answeredAt != null) {
      messages.push({
        id: `${row.id}:user`,
        prompt_id: row.id,
        role: 'user',
        text: row.answer ?? '',
        created_at: toIso(row.answeredAt),
        attachments: [],
      });
    } else {
      const pendingMessage: ThreadMessage = {
        id: `${row.id}:pending`,
        prompt_id: row.id,
        role: 'pending',
        text: '待你答',
        created_at: toIso(row.createdAt),
        attachments: [],
      };
      if (options) {
        pendingMessage.options = options;
      }
      messages.push(pendingMessage);
    }
  }

  return { agent_id: agentId, messages };
}

export function mountPromptThread(app: Express, db: HubDb): void {
  app.get('/api/ui/prompts/thread', (req, res) => {
    const agentId = req.query.agent_id;
    if (typeof agentId !== 'string' || agentId.length === 0) {
      res.status(400).json({ error: 'agent_id required' });
      return;
    }

    const rows = db
      .select()
      .from(uiPrompts)
      .where(eq(uiPrompts.agentId, agentId))
      .orderBy(asc(uiPrompts.createdAt))
      .all();

    res.json(buildThread(agentId, rows));
  });
}
