#!/usr/bin/env node
/**
 * Phase-1: disable AFK control-plane MCP servers in ~/.cursor/mcp.json
 * Keeps capability MCPs (figma, browsers, docs, …).
 * Creates timestamped backup. Does not delete server binaries.
 *
 * Usage: node scripts/afk-mcp-control-plane-disable.mjs [--dry-run] [--apply]
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DISABLE = new Set([
  'rr-chat',
  'xj-chat',
  'polarcop-xj',
  ...Array.from({ length: 20 }, (_, i) => `hub-agent-${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `my-mcp-${i + 1}`),
]);

const apply = process.argv.includes('--apply');
const dry = !apply || process.argv.includes('--dry-run');
const mcpPath = process.env.CURSOR_MCP_JSON || join(homedir(), '.cursor', 'mcp.json');

if (!existsSync(mcpPath)) {
  console.error(JSON.stringify({ ok: false, error: 'mcp_json_missing', mcpPath }));
  process.exit(1);
}

const raw = JSON.parse(readFileSync(mcpPath, 'utf8'));
const servers = raw.mcpServers || {};
const removed = [];
const kept = [];
for (const key of Object.keys(servers)) {
  if (DISABLE.has(key)) removed.push(key);
  else kept.push(key);
}

const next = {
  ...raw,
  mcpServers: Object.fromEntries(kept.map((k) => [k, servers[k]])),
};

const report = {
  ok: true,
  dryRun: dry,
  mcpPath,
  wouldRemove: removed,
  keptCount: kept.length,
  featureFlag: 'AFK_CONTROL_PLANE_MCP=0',
};

if (dry) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const bak = `${mcpPath}.pre-afk-vnext-${Date.now()}.bak`;
copyFileSync(mcpPath, bak);
writeFileSync(mcpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, dryRun: false, backup: bak }, null, 2));
