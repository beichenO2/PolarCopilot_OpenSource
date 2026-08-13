import type { Express } from 'express';
import type { HubDb } from '../persistence/db.js';
import { mountPromptThread } from './prompt-thread.js';
import { mountTopicHtml } from './topic-html.js';

export function mountP2Surface(
  app: Express,
  opts: { hubDb: HubDb; mirrorRoot: string },
): void {
  mountPromptThread(app, opts.hubDb);
  mountTopicHtml(app, { rootDir: opts.mirrorRoot });
}
