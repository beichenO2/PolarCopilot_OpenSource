import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, unlinkSync, watchFile, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { hubConfigSchema } from '../protocol/config.js';
import type { HubUpdateConfigInput, HubUpdateConfigOutput } from '../protocol/config.js';
import type { HubConfig } from '../types.js';
import { defaultConfigForPreset, interventionMatrixForPreset } from './presets.js';

export function configFilePath(root: string): string {
  return join(resolve(root), 'config.json');
}

function safeInsideRoot(root: string, fileAbs: string): boolean {
  const r = resolve(root);
  const prefix = r.endsWith(sep) ? r : r + sep;
  return fileAbs === r || fileAbs.startsWith(prefix);
}

function atomicWriteJson(targetPath: string, value: unknown) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(tmp, targetPath);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export function loadConfigFromDisk(root: string): HubConfig {
  const p = configFilePath(root);
  if (!existsSync(p)) {
    const cfg = defaultConfigForPreset('full_auto');
    atomicWriteJson(p, cfg);
    return cfg;
  }
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  if (raw.intervention_matrix && typeof raw.intervention_matrix === 'object') {
    const im = raw.intervention_matrix as Record<string, unknown>;
    if (!('compile' in im)) {
      im.compile = 'notify';
    }
  }
  return hubConfigSchema.parse(raw);
}

export function watchConfig(root: string, onChange: (cfg: HubConfig) => void): () => void {
  const p = configFilePath(root);
  watchFile(p, { interval: 750 }, () => {
    try {
      onChange(loadConfigFromDisk(root));
    } catch {
      /* ignore reload errors */
    }
  });
  return () => {
    unwatchFile(p);
  };
}

export function updateConfigOnDisk(root: string, input: HubUpdateConfigInput): HubUpdateConfigOutput {
  const p = configFilePath(root);
  if (!safeInsideRoot(root, p)) {
    throw new Error('config_path_unsafe');
  }

  const current = loadConfigFromDisk(root);
  if (current.version !== input.expected_version) {
    return { status: 'conflict', config: current };
  }

  const next: HubConfig = { ...current };

  if (input.patch.automation_preset) {
    next.automation_preset = input.patch.automation_preset;
  }
  if (input.patch.intervention_matrix) {
    next.intervention_matrix = { ...next.intervention_matrix, ...input.patch.intervention_matrix };
  }
  if (input.patch.automation_preset && !input.patch.intervention_matrix) {
    next.intervention_matrix = interventionMatrixForPreset(input.patch.automation_preset);
  }
  if (input.patch.workspace_root !== undefined) {
    next.workspace_root = input.patch.workspace_root;
  }
  if (input.patch.default_lease_ttl_ms !== undefined) {
    next.default_lease_ttl_ms = input.patch.default_lease_ttl_ms;
  }
  if (input.patch.default_task_lease_ms !== undefined) {
    next.default_task_lease_ms = input.patch.default_task_lease_ms;
  }

  next.version = current.version + 1;

  const parsed = hubConfigSchema.parse(next);
  atomicWriteJson(p, parsed);
  return { status: 'success', config: parsed };
}
