import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AfkSnapshot, OrchestratorConfig } from './types.js';

function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function firstExisting(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const path = join(root, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function detectTaskDir(afkRoot: string): string | null {
  if (!existsSync(afkRoot)) return null;
  const entries = readdirSync(afkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(afkRoot, entry.name))
    .filter((dir) => existsSync(join(dir, 'CRITERIA.md')) || existsSync(join(dir, 'TODO.md')));
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b.localeCompare(a))[0] ?? null;
}

export function readAfkSnapshot(config: OrchestratorConfig): AfkSnapshot {
  const active = existsSync(join(config.afkRoot, 'ACTIVE'));
  const paused = existsSync(join(config.afkRoot, 'PAUSE'));
  const done = existsSync(join(config.afkRoot, 'DONE'));
  const taskDir = detectTaskDir(config.afkRoot);
  const maxLoopsRaw = readText(join(config.afkRoot, 'MAX_LOOPS'));
  const maxLoops = maxLoopsRaw ? Number(maxLoopsRaw.trim()) || config.maxLoops : config.maxLoops;

  const criteriaPath = taskDir
    ? join(taskDir, 'CRITERIA.md')
    : firstExisting(config.projectRoot, config.criteriaPaths);
  const todoPath = taskDir
    ? join(taskDir, 'TODO.md')
    : firstExisting(config.projectRoot, config.todoPaths);

  return {
    active,
    paused,
    done,
    taskDir,
    criteriaText: criteriaPath ? readText(criteriaPath) : null,
    todoText: todoPath ? readText(todoPath) : null,
    maxLoops,
  };
}

export function parseTodoItems(todoText: string | null): string[] {
  if (!todoText) return [];
  return todoText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[ \]/.test(line))
    .map((line) => line.replace(/^[-*]\s+\[ \]\s*/, '').trim())
    .filter(Boolean);
}

export function parseCriteriaSummary(criteriaText: string | null): string[] {
  if (!criteriaText) return [];
  return criteriaText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+\./.test(line))
    .slice(0, 12);
}
