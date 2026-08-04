import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { OrchestratorConfig } from './types.js';

const DEFAULTS: OrchestratorConfig = {
  hubUrl: process.env.PC_HUB_URL ?? 'http://127.0.0.1:8040',
  projectRoot: process.env.PC_PROJECT_DIR ?? process.cwd(),
  masterSessionId: null,
  masterSessionName: null,
  afkRoot: join(homedir(), '.cursor', 'afk'),
  pollIntervalMs: 5_000,
  idleInjectDelayMs: 20_000,
  offlineWakeDelayMs: 45_000,
  maxInjectionsPerHour: 120,
  maxLoops: 40,
  autoDispatchSubagents: true,
  loopBridge: true,
  loopSentinelPrefix: 'RR_ORCH_TICK',
  todoPaths: ['TODO.md', '.cursor/afk/TODO.md'],
  criteriaPaths: ['.cursor/afk/CRITERIA.md'],
  verifyCommands: [],
  injectPrefix: '【Rr Orchestrator · AFK 续跑】',
  statePath: join(homedir(), '.rr-cursor', 'orchestrator', 'state.json'),
  logPath: join(homedir(), '.rr-cursor', 'orchestrator', 'events.jsonl'),
  maintainSubagentPool: false,
  allowNewSubagents: true,
  desiredSubagents: 0,
  managedSubagentIds: [],
  subagentRecoveryCooldownMs: 45_000,
  subagentPruneAfterMs: 15 * 60_000,
  subagentHeadless: true,
  budgetShedder: true,
  budgetPausableServiceIds: [],
  budgetMaxPausePerTick: 2,
  budgetMaxResumePerTick: 2,
};

function expandHome(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function mergeConfig(base: OrchestratorConfig, patch: Record<string, unknown>): OrchestratorConfig {
  const next = { ...base, ...patch } as OrchestratorConfig;
  next.projectRoot = resolve(expandHome(String(next.projectRoot)));
  next.afkRoot = expandHome(String(next.afkRoot));
  next.statePath = expandHome(String(next.statePath));
  next.logPath = expandHome(String(next.logPath));
  if (Array.isArray(patch.todoPaths)) next.todoPaths = patch.todoPaths.map(String);
  if (Array.isArray(patch.criteriaPaths)) next.criteriaPaths = patch.criteriaPaths.map(String);
  if (Array.isArray(patch.verifyCommands)) next.verifyCommands = patch.verifyCommands.map(String);
  return next;
}

export function globalConfigPath(): string {
  return join(homedir(), '.rr-cursor', 'orchestrator', 'config.json');
}

export function readAllowNewSubagents(path = globalConfigPath()): boolean {
  if (!existsSync(path)) return DEFAULTS.allowNewSubagents !== false;
  return readJson(path).allowNewSubagents !== false;
}

export function configPaths(projectRoot: string): string[] {
  return [
    globalConfigPath(),
    join(projectRoot, '.rr-orchestrator.json'),
  ];
}

/**
 * Load orchestrator config.
 *
 * - If `bootstrapRoot/.rr-orchestrator.json` exists, that root is authoritative
 *   (tests / explicit project). Global config may still supply other fields, but
 *   not override projectRoot.
 * - Otherwise global `~/.rr-cursor/orchestrator/config.json` may set projectRoot
 *   (so Hub cwd / PC_PROJECT_DIR no longer traps AFK onto PolarCopilot/hub).
 * - Finally merge `<projectRoot>/.rr-orchestrator.json` when present.
 */
export function loadConfig(bootstrapRoot = process.env.PC_PROJECT_DIR ?? process.cwd()): OrchestratorConfig {
  const bootstrap = resolve(bootstrapRoot);
  let config: OrchestratorConfig = { ...DEFAULTS, projectRoot: bootstrap };
  const bootstrapOverlay = join(bootstrap, '.rr-orchestrator.json');
  const hasBootstrapOverlay = existsSync(bootstrapOverlay);
  const globalPath = globalConfigPath();

  if (existsSync(globalPath)) {
    const globalPatch = readJson(globalPath);
    if (hasBootstrapOverlay) {
      const { projectRoot: _ignored, ...rest } = globalPatch;
      config = mergeConfig(config, rest);
    } else {
      config = mergeConfig(config, globalPatch);
    }
  }

  if (hasBootstrapOverlay) {
    config = mergeConfig(config, readJson(bootstrapOverlay));
  } else {
    const projectOverlay = join(config.projectRoot, '.rr-orchestrator.json');
    if (existsSync(projectOverlay)) {
      config = mergeConfig(config, readJson(projectOverlay));
    }
  }

  mkdirSync(join(homedir(), '.rr-cursor', 'orchestrator'), { recursive: true, mode: 0o700 });
  return config;
}

export function patchGlobalConfig(patch: Record<string, unknown>, path = globalConfigPath()): OrchestratorConfig {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  let base: Record<string, unknown> = {};
  if (existsSync(path)) {
    base = readJson(path);
  } else {
    const defaults = loadConfig();
    base = {
      hubUrl: defaults.hubUrl,
      projectRoot: defaults.projectRoot,
      masterSessionId: defaults.masterSessionId,
      pollIntervalMs: defaults.pollIntervalMs,
      idleInjectDelayMs: defaults.idleInjectDelayMs,
      autoDispatchSubagents: defaults.autoDispatchSubagents,
      loopBridge: defaults.loopBridge,
      todoPaths: defaults.todoPaths,
      criteriaPaths: defaults.criteriaPaths,
      verifyCommands: defaults.verifyCommands,
      maintainSubagentPool: defaults.maintainSubagentPool,
      allowNewSubagents: defaults.allowNewSubagents,
      desiredSubagents: defaults.desiredSubagents,
      managedSubagentIds: defaults.managedSubagentIds,
      subagentRecoveryCooldownMs: defaults.subagentRecoveryCooldownMs,
      subagentPruneAfterMs: defaults.subagentPruneAfterMs,
      subagentHeadless: defaults.subagentHeadless,
    };
  }
  writeFileSync(path, `${JSON.stringify({ ...base, ...patch }, null, 2)}\n`, 'utf8');
  return loadConfig(String(patch.projectRoot ?? base.projectRoot ?? process.env.PC_PROJECT_DIR ?? process.cwd()));
}

export function writeDefaultConfig(path = globalConfigPath()): OrchestratorConfig {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const config = loadConfig();
  if (!existsSync(path)) {
    writeFileSync(path, `${JSON.stringify({
      hubUrl: config.hubUrl,
      projectRoot: config.projectRoot,
      masterSessionId: null,
      pollIntervalMs: config.pollIntervalMs,
      idleInjectDelayMs: config.idleInjectDelayMs,
      autoDispatchSubagents: true,
      loopBridge: true,
      todoPaths: config.todoPaths,
      criteriaPaths: config.criteriaPaths,
      verifyCommands: [],
      maintainSubagentPool: true,
      allowNewSubagents: true,
      desiredSubagents: 0,
      managedSubagentIds: [],
      subagentRecoveryCooldownMs: 45_000,
      subagentPruneAfterMs: 15 * 60_000,
      subagentHeadless: true,
    }, null, 2)}\n`, 'utf8');
  }
  return loadConfig(config.projectRoot);
}
