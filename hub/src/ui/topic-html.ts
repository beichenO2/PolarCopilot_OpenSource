import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Express } from 'express';

const TOPIC_ID_RE = /^[A-Za-z0-9._-]+$/;

export interface MountTopicHtmlOptions {
  rootDir: string;
}

export function isValidTopicId(topicId: string): boolean {
  if (topicId === '.' || topicId === '..') {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(topicId)) {
    return false;
  }
  return TOPIC_ID_RE.test(topicId);
}

function topicDir(rootDir: string, topicId: string): string {
  return join(rootDir, topicId);
}

function indexPath(rootDir: string, topicId: string): string {
  return join(topicDir(rootDir, topicId), 'index.html');
}

function removeExtraHtmlFiles(rootDir: string, topicId: string): void {
  const dir = topicDir(rootDir, topicId);
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.html') && name !== 'index.html') {
      unlinkSync(join(dir, name));
    }
  }
}

export function mountTopicHtml(app: Express, opts: MountTopicHtmlOptions): void {
  const { rootDir } = opts;

  app.put('/api/ui/topics/:topicId/html', express.json(), (req, res) => {
    const topicId = req.params.topicId;
    if (!topicId || !isValidTopicId(topicId)) {
      res.status(400).json({ error: 'invalid_topic_id' });
      return;
    }

    const body = req.body as { html?: unknown; filename?: unknown };
    if (typeof body.html !== 'string') {
      res.status(400).json({ error: 'invalid_body' });
      return;
    }

    if (body.filename !== undefined && body.filename !== 'index.html') {
      res.status(409).json({ error: 'topic_overwrite' });
      return;
    }

    const dir = topicDir(rootDir, topicId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexPath(rootDir, topicId), body.html, 'utf8');
    removeExtraHtmlFiles(rootDir, topicId);

    res.json({ ok: true, topic: topicId, path: 'index.html' });
  });

  app.get('/api/ui/topics/:topicId/html', (req, res) => {
    const topicId = req.params.topicId;
    if (!topicId || !isValidTopicId(topicId)) {
      res.status(400).json({ error: 'invalid_topic_id' });
      return;
    }

    const filePath = indexPath(rootDir, topicId);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const html = readFileSync(filePath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });
}
