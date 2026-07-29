#!/usr/bin/env node
import { writeDefaultConfig, loadConfig } from './orchestrator/config.js';
import { readOrchestratorHealth } from './orchestrator/health.js';
import { RrOrchestratorRunner, orchestratorStatus } from './orchestrator/runner.js';
import { RrHubClient } from './orchestrator/hub-client.js';
import { isOrchestratorEnabled, setOrchestratorEnabled } from './orchestrator/toggle.js';

const POLARPROCESS_URL = process.env.POLARPROCESS_URL ?? 'http://127.0.0.1:11055';
const SERVICE_ID = 'rr-orchestrator';

function usage(): never {
  console.error(`Usage: rr-orchestrator <command>

Commands:
  init                 Write ~/.rr-cursor/orchestrator/config.json defaults
  enable               Turn on orchestrator (writes enabled flag)
  disable              Turn off orchestrator (removes enabled flag)
  start                enable + PolarProcess start ${SERVICE_ID}
  stop                 PolarProcess stop ${SERVICE_ID} (keeps enabled flag)
  halt                 disable + PolarProcess stop ${SERVICE_ID}
  run                  Start daemon loop (SSE + poll + inject/dispatch)
  once [--force]       Evaluate once; --force ignores enabled flag
  status               Print JSON status snapshot
  health               Print orchestrator health JSON (Hub-compatible)
  inject <sessionId> <text...>   Manual Hub POST (panel-equivalent)
  wake <sessionId>             Send standard wake prompt

Environment:
  PC_PROJECT_DIR       Project root for TODO/CRITERIA resolution
  PC_HUB_URL           Hub base URL (default http://127.0.0.1:8040)
  POLARPROCESS_URL     PolarProcess base (default http://127.0.0.1:11055)
`);
  process.exit(2);
}

async function polarRequest(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${POLARPROCESS_URL}${path}`, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`PolarProcess ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) as unknown : { ok: true };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  if (command === 'init') {
    const config = writeDefaultConfig();
    console.log(JSON.stringify({ ok: true, configPath: config.statePath.replace('state.json', 'config.json') }, null, 2));
    return;
  }

  const config = loadConfig();

  if (command === 'enable') {
    setOrchestratorEnabled(true);
    console.log(JSON.stringify({ ok: true, enabled: true }, null, 2));
    return;
  }

  if (command === 'disable') {
    setOrchestratorEnabled(false);
    console.log(JSON.stringify({ ok: true, enabled: false }, null, 2));
    return;
  }

  if (command === 'start') {
    setOrchestratorEnabled(true);
    const result = await polarRequest(`/api/services/${SERVICE_ID}/start`, { method: 'POST' });
    console.log(JSON.stringify({ ok: true, enabled: true, polarprocess: result }, null, 2));
    return;
  }

  if (command === 'stop') {
    const result = await polarRequest(`/api/services/${SERVICE_ID}/stop`, { method: 'POST' });
    console.log(JSON.stringify({ ok: true, enabled: isOrchestratorEnabled(), polarprocess: result }, null, 2));
    return;
  }

  if (command === 'halt') {
    setOrchestratorEnabled(false);
    const result = await polarRequest(`/api/services/${SERVICE_ID}/stop`, { method: 'POST' });
    console.log(JSON.stringify({ ok: true, enabled: false, polarprocess: result }, null, 2));
    return;
  }

  if (command === 'status') {
    console.log(JSON.stringify({
      ...(await orchestratorStatus(config)),
      enabled: isOrchestratorEnabled(),
      health: readOrchestratorHealth(config.projectRoot),
    }, null, 2));
    return;
  }

  if (command === 'health') {
    console.log(JSON.stringify(readOrchestratorHealth(config.projectRoot), null, 2));
    return;
  }

  if (command === 'inject') {
    const [sessionId, ...parts] = rest;
    if (!sessionId || parts.length === 0) usage();
    const client = new RrHubClient({ hubUrl: config.hubUrl });
    const message = await client.injectMessage(sessionId, parts.join(' '));
    console.log(JSON.stringify({ ok: true, message }, null, 2));
    return;
  }

  if (command === 'wake') {
    const [sessionId] = rest;
    if (!sessionId) usage();
    const client = new RrHubClient({ hubUrl: config.hubUrl });
    const content = [
      config.injectPrefix,
      '',
      '【手动唤醒】请立刻 wait_message 恢复轮询，读取 TODO/CRITERIA 继续 AFK 任务。',
      `项目根：${config.projectRoot}`,
    ].join('\n');
    const message = await client.injectMessage(sessionId, content);
    console.log(JSON.stringify({ ok: true, message }, null, 2));
    return;
  }

  const runner = new RrOrchestratorRunner(config);
  process.on('SIGINT', () => runner.stop());
  process.on('SIGTERM', () => runner.stop());

  if (command === 'once') {
    const force = rest.includes('--force');
    if (!force && !isOrchestratorEnabled()) {
      console.log(JSON.stringify({ ok: true, action: 'noop', reason: 'orchestrator disabled' }, null, 2));
      return;
    }
    const tick = await runner.tickOnce();
    console.log(JSON.stringify(tick ?? { ok: true, action: 'noop' }, null, 2));
    return;
  }

  if (command === 'run') {
    if (!isOrchestratorEnabled()) {
      console.error('Orchestrator disabled. Run: rr-orchestrator enable (or start)');
      process.exit(1);
    }
    await runner.run();
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
