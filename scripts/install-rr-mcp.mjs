import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CURSOR_MCP_CONFIG ?? join(homedir(), '.cursor', 'mcp.json');
const serverName = 'rr-chat';
const expected = {
  command: '/bin/bash',
  args: [join(projectRoot, 'Start', 'rr-mcp.sh')],
  env: {
    RR_DATA_ROOT: join(homedir(), '.rr-cursor', 'chat'),
    RR_POLL_TICK_MS: '60000',
    RR_OFFLINE_MS: '90000',
    RR_TASK_STALE_MS: '1800000',
    RR_ADOPT_CURSOR_LIFECYCLE: '1',
    RR_SCHEMA_VERSION: '3',
  },
};

function loadConfig() {
  if (!existsSync(configPath)) return { mcpServers: {} };
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cursor MCP config must be a JSON object');
  if (!parsed.mcpServers) parsed.mcpServers = {};
  if (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error('mcpServers must be an object');
  return parsed;
}

const config = loadConfig();
if (process.argv.includes('--verify')) {
  if (JSON.stringify(config.mcpServers[serverName]) !== JSON.stringify(expected)) {
    console.error(`${serverName} is not installed with the expected local Rr command`);
    process.exit(1);
  }
  if (config.mcpServers['polarcop-xj']) {
    console.error('legacy polarcop-xj entry is still installed');
    process.exit(1);
  }
  console.log(`${serverName} MCP config verified`);
  process.exit(0);
}

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.pre-rr-chat.bak`);
delete config.mcpServers['polarcop-xj'];
config.mcpServers[serverName] = expected;
const tmp = `${configPath}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
renameSync(tmp, configPath);
console.log(`${serverName} installed in ${configPath}; legacy polarcop-xj entry removed`);
