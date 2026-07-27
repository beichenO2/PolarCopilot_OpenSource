import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../hub/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../hub/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const root = mkdtempSync(join(tmpdir(), 'rr-stdio-'));
const transport = new StdioClientTransport({
  command: '/bin/bash',
  args: ['~/Polarisor/PolarCopilot/Start/rr-mcp.sh'],
  env: { ...process.env, RR_DATA_ROOT: root },
});
const client = new Client({ name: 'rr-smoke', version: '1.0.0' });

try {
  await client.connect(transport);
  const server = client.getServerVersion();
  const tools = await client.listTools();
  const registered = await client.callTool({ name: 'register_session', arguments: { name: 'Smoke' } });
  console.log(JSON.stringify({
    server,
    tools: tools.tools.map((tool) => tool.name),
    register: (registered.content?.[0]?.text ?? '').split('\n').slice(0, 3),
  }));
} finally {
  await client.close();
  rmSync(root, { recursive: true, force: true });
}

