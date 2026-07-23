import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CURSOR_MCP_CONFIG ?? join(homedir(), '.cursor', 'mcp.json');
const serverName = 'polarcop-xj';
const expected = {
  command: '/bin/bash',
  args: [join(projectRoot, 'Start', 'xj-mcp.sh')],
  env: {
    PC_XJ_DATA_ROOT: join(homedir(), '.polarcopilot', 'xj'),
    PC_XJ_SKILL_ROOT: join(homedir(), 'Desktop', 'XJ', '截图技能Prompt明文'),
    PC_XJ_SCHEMA_VERSION: '2',
  },
};

function loadConfig() {
  if (!existsSync(configPath)) return { mcpServers: {} };
  const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cursor MCP config must be a JSON object');
  if (!parsed.mcpServers) parsed.mcpServers = {};
  if (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error('mcpServers must be an object');
  return parsed;
}

function sameEntry(actual) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

const config = loadConfig();
if (process.argv.includes('--verify')) {
  if (!sameEntry(config.mcpServers[serverName])) {
    console.error(`${serverName} is not installed with the expected PolarCopilot command`);
    process.exit(1);
  }
  console.log(`${serverName} MCP config verified`);
  process.exit(0);
}

mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.pre-polarcop-xj.bak`);
config.mcpServers[serverName] = expected;
const tmp = `${configPath}.${process.pid}.tmp`;
writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
renameSync(tmp, configPath);
console.log(`${serverName} installed in ${configPath}`);
