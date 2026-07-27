#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRrMcpServer } from './mcp-server.js';
import { RrFileStore } from './store.js';

const dataRoot = process.env.RR_DATA_ROOT ?? join(homedir(), '.rr-cursor', 'chat');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

const store = new RrFileStore(dataRoot, {
  offlineAfterMs: Number(process.env.RR_OFFLINE_MS ?? 90_000),
  taskStaleAfterMs: Number(process.env.RR_TASK_STALE_MS ?? 30 * 60_000),
});
const server = createRrMcpServer(store);
const transport = new StdioServerTransport();
const recovery = setInterval(() => store.recoverStaleTasks(), 30_000);
recovery.unref();

async function close() {
  clearInterval(recovery);
  await server.close();
}

process.stdin.on('end', () => void close().finally(() => process.exit(0)));
process.on('SIGTERM', () => void close().finally(() => process.exit(0)));
process.on('SIGINT', () => void close().finally(() => process.exit(0)));

await server.connect(transport);

