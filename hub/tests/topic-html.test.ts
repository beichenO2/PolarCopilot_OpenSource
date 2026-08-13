import express from 'express';
import { existsSync, mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isValidTopicId, mountTopicHtml } from '../src/ui/topic-html.js';

type RunningServer = { baseUrl: string; close: () => Promise<void> };

async function startTopicHtmlServer(rootDir: string): Promise<RunningServer> {
  const app = express();
  mountTopicHtml(app, { rootDir });

  let server: Server;
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error('no listen address'));
      }
    });
    server.on('error', reject);
  });

  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { baseUrl, close };
}

function htmlFilesInTopic(rootDir: string, topicId: string): string[] {
  const topicDir = join(rootDir, topicId);
  return readdirSync(topicDir).filter((name) => name.endsWith('.html'));
}

describe('isValidTopicId', () => {
  it.each(['.', '..'] as const)('rejects dot-segment %j', (topicId) => {
    expect(isValidTopicId(topicId)).toBe(false);
  });

  it('accepts topic names containing dots', () => {
    expect(isValidTopicId('foo.bar')).toBe(true);
  });
});

describe('mountTopicHtml', () => {
  const roots: string[] = [];

  afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('GET returns 404 when topic html does not exist', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);

    try {
      const resp = await fetch(`${server.baseUrl}/api/ui/topics/my-topic/html`);
      expect(resp.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('PUT topicId=foo.bar returns 200 (dot name is not a dot-segment)', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const topicId = 'foo.bar';
    const html = '<!doctype html><html><body>dotted topic</body></html>';

    try {
      const putResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      expect(putResp.status).toBe(200);
      expect(await putResp.json()).toEqual({ ok: true, topic: topicId, path: 'index.html' });

      const getResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`);
      expect(getResp.status).toBe(200);
      expect(await getResp.text()).toBe(html);
    } finally {
      await server.close();
    }
  });

  it('PUT without filename writes index.html and GET returns raw html', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const topicId = 'design-gate';
    const html = '<!doctype html><html><body>gate v1</body></html>';

    try {
      const putResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html }),
      });
      expect(putResp.status).toBe(200);
      expect(await putResp.json()).toEqual({ ok: true, topic: topicId, path: 'index.html' });

      const getResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`);
      expect(getResp.status).toBe(200);
      expect(getResp.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await getResp.text()).toBe(html);
    } finally {
      await server.close();
    }
  });

  it('PUT with filename index.html overwrites and second PUT wins on GET', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const topicId = 'overwrite-topic';
    const first = '<html>first</html>';
    const second = '<html>second</html>';

    try {
      const put1 = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: first, filename: 'index.html' }),
      });
      expect(put1.status).toBe(200);

      const put2 = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: second }),
      });
      expect(put2.status).toBe(200);

      const getResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`);
      expect(await getResp.text()).toBe(second);
    } finally {
      await server.close();
    }
  });

  it('PUT with alternate filename returns 409 topic_overwrite', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const topicId = 'no-alt-file';

    try {
      const resp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<html>v2</html>', filename: 'v2.html' }),
      });
      expect(resp.status).toBe(409);
      expect(await resp.json()).toEqual({ error: 'topic_overwrite' });
    } finally {
      await server.close();
    }
  });

  /** Express normalizes `.`/`..` in paths; double-encode so param reaches handler as %2E / %2E%2E. */
  function traversalUrlSegment(topicId: '.' | '..'): string {
    return topicId === '.' ? '%252E' : '%252E%252E';
  }

  it.each(['.', '..'] as const)(
    'rejects path-traversal topicId %j with 400 and does not write outside rootDir',
    async (topicId) => {
      const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
      roots.push(rootDir);
      const parentDir = dirname(rootDir);
      const parentBefore = readdirSync(parentDir);
      const server = await startTopicHtmlServer(rootDir);

      try {
        const putResp = await fetch(`${server.baseUrl}/api/ui/topics/${traversalUrlSegment(topicId)}/html`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html: '<html>escape</html>' }),
        });
        expect(putResp.status).toBe(400);
        expect(await putResp.json()).toEqual({ error: 'invalid_topic_id' });

        const getResp = await fetch(`${server.baseUrl}/api/ui/topics/${traversalUrlSegment(topicId)}/html`);
        expect(getResp.status).toBe(400);
        expect(await getResp.json()).toEqual({ error: 'invalid_topic_id' });

        expect(existsSync(join(rootDir, 'index.html'))).toBe(false);
        expect(readdirSync(rootDir)).toEqual([]);
        expect(readdirSync(parentDir)).toEqual(parentBefore);
      } finally {
        await server.close();
      }
    },
  );

  it('rejects invalid topicId with 400', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const badId = 'topic/with/slash';

    try {
      const putResp = await fetch(`${server.baseUrl}/api/ui/topics/${encodeURIComponent(badId)}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<html>x</html>' }),
      });
      expect(putResp.status).toBe(400);

      const getResp = await fetch(`${server.baseUrl}/api/ui/topics/${encodeURIComponent(badId)}/html`);
      expect(getResp.status).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('after successful PUT topic directory contains exactly one html file', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'topic-html-'));
    roots.push(rootDir);
    const server = await startTopicHtmlServer(rootDir);
    const topicId = 'single-html';
    const topicDir = join(rootDir, topicId);
    mkdirSync(topicDir, { recursive: true });
    writeFileSync(join(topicDir, 'legacy.html'), '<html>legacy</html>', 'utf8');

    try {
      const putResp = await fetch(`${server.baseUrl}/api/ui/topics/${topicId}/html`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html: '<html>live</html>' }),
      });
      expect(putResp.status).toBe(200);
      expect(htmlFilesInTopic(rootDir, topicId)).toEqual(['index.html']);
    } finally {
      await server.close();
    }
  });
});
