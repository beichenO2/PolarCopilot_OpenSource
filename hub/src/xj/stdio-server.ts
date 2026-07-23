#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createXjMcpServer } from './mcp-server.js';
import { defaultXjSkillRoot, XjSkillRouter } from './skill-router.js';
import { XjFileStore } from './store.js';

const dataRoot = process.env.PC_XJ_DATA_ROOT
  ?? join(homedir(), '.polarcopilot', 'xj');
mkdirSync(dataRoot, { recursive: true, mode: 0o700 });

const server = createXjMcpServer({
  store: new XjFileStore(dataRoot, { staleAfterMs: 24 * 60 * 60 * 1000 }),
  skillRouter: new XjSkillRouter(defaultXjSkillRoot()),
});
const transport = new StdioServerTransport();

process.stdin.on('end', () => void server.close().finally(() => process.exit(0)));
process.on('SIGTERM', () => void server.close().finally(() => process.exit(0)));
process.on('SIGINT', () => void server.close().finally(() => process.exit(0)));

await server.connect(transport);
