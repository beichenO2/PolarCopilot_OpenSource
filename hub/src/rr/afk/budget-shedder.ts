import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afkRoot } from './paths.js';
import {
  fetchPauseRecommendations,
  fetchPolarBudget,
  inferPressureLevel,
  type PolarBudgetPressureLevel,
} from '../polar-budget.js';
import {
  getPolarProcessService,
  startPolarProcessService,
  stopPolarProcessService,
} from '../polar-process-client.js';

/** Never pause PolarManager / Hub authorities (matches PolarBudget NEVER_PAUSE). */
export const AUTHORITY_SERVICE_IDS = [
  'polar-port',
  'polar-process',
  'polar-budget',
  'polarcop-hub',
  'polarprivate',
  'polar-memory',
] as const;

export interface ShedStateEntry {
  serviceId: string;
  pausedAt: string;
  reason: string;
  pressure_level: PolarBudgetPressureLevel;
}

export interface ShedState {
  paused: ShedStateEntry[];
  updated_at: string;
}

export interface ShedTickResult {
  pressure_level: PolarBudgetPressureLevel;
  recommended_jobs: number;
  paused: string[];
  resumed: string[];
  skipped: string[];
  note?: string;
}

function shedStatePath(): string {
  return join(afkRoot(), 'budget-shed.json');
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

export function readShedState(): ShedState {
  const path = shedStatePath();
  if (!existsSync(path)) return { paused: [], updated_at: new Date().toISOString() };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ShedState;
    return {
      paused: Array.isArray(raw.paused) ? raw.paused : [],
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
    };
  } catch {
    return { paused: [], updated_at: new Date().toISOString() };
  }
}

export function writeShedState(state: ShedState): void {
  atomicWrite(shedStatePath(), state);
}

export function isAuthorityServiceId(serviceId: string): boolean {
  const lower = serviceId.toLowerCase();
  return AUTHORITY_SERVICE_IDS.some(
    (id) => lower === id || lower.startsWith(`${id}-`) || lower.startsWith(`${id}_`),
  );
}

/**
 * Optional allowlist: only these service ids may be paused.
 * Empty allowlist → use Budget recommendations minus authorities.
 */
export function filterPauseTargets(
  candidates: Array<{ ref: string; reason?: string }>,
  allowlist: string[] = [],
): Array<{ serviceId: string; reason: string }> {
  const allow = new Set(allowlist.map((id) => id.toLowerCase()));
  const out: Array<{ serviceId: string; reason: string }> = [];
  for (const candidate of candidates) {
    const id = candidate.ref;
    if (isAuthorityServiceId(id)) continue;
    if (allow.size > 0 && !allow.has(id.toLowerCase())) continue;
    out.push({ serviceId: id, reason: candidate.reason ?? 'budget_pressure' });
  }
  return out;
}

export interface BudgetShedderDeps {
  fetchBudget?: typeof fetchPolarBudget;
  fetchRecommendations?: typeof fetchPauseRecommendations;
  stopService?: typeof stopPolarProcessService;
  startService?: typeof startPolarProcessService;
  getService?: typeof getPolarProcessService;
  maxPausePerTick?: number;
  maxResumePerTick?: number;
  /** When set, only these PolarProcess ids may be paused. */
  pausableAllowlist?: string[];
}

/**
 * One shedder tick:
 * - critical → pause up to N recommended pausable services (stop via PolarProcess)
 * - plenty → resume previously paused services (start via PolarProcess)
 * - tight → no pause/resume; callers should clamp concurrency only
 *
 * Never restarts Hub/Port/Process/Budget.
 */
export async function runBudgetShedderTick(deps: BudgetShedderDeps = {}): Promise<ShedTickResult> {
  const fetchBudget = deps.fetchBudget ?? fetchPolarBudget;
  const fetchRecommendations = deps.fetchRecommendations ?? fetchPauseRecommendations;
  const stopService = deps.stopService ?? stopPolarProcessService;
  const startService = deps.startService ?? startPolarProcessService;
  const maxPause = deps.maxPausePerTick ?? 2;
  const maxResume = deps.maxResumePerTick ?? 2;

  const budget = await fetchBudget();
  const recommended_jobs = budget.recommended_jobs;
  const pressure_level = budget.ok
    ? (budget.pressure_level ?? inferPressureLevel(recommended_jobs))
    : inferPressureLevel(recommended_jobs);

  const state = readShedState();
  const paused: string[] = [];
  const resumed: string[] = [];
  const skipped: string[] = [];

  if (pressure_level === 'critical') {
    const rec = await fetchRecommendations(20);
    const targets = filterPauseTargets(rec.candidates, deps.pausableAllowlist ?? []).filter(
      (t) => !state.paused.some((p) => p.serviceId === t.serviceId),
    );
    for (const target of targets.slice(0, maxPause)) {
      if (isAuthorityServiceId(target.serviceId)) {
        skipped.push(target.serviceId);
        continue;
      }
      try {
        const result = await stopService(target.serviceId);
        if (!result.ok) {
          skipped.push(target.serviceId);
          continue;
        }
        state.paused.push({
          serviceId: target.serviceId,
          pausedAt: new Date().toISOString(),
          reason: target.reason,
          pressure_level,
        });
        paused.push(target.serviceId);
      } catch {
        skipped.push(target.serviceId);
      }
    }
  } else if (pressure_level === 'plenty' && state.paused.length > 0) {
    const toResume = state.paused.slice(-maxResume).reverse();
    const remaining: ShedStateEntry[] = [];
    for (const entry of state.paused) {
      if (!toResume.some((r) => r.serviceId === entry.serviceId)) {
        remaining.push(entry);
        continue;
      }
      if (isAuthorityServiceId(entry.serviceId)) {
        skipped.push(entry.serviceId);
        continue;
      }
      try {
        const result = await startService(entry.serviceId);
        if (!result.ok) {
          remaining.push(entry);
          skipped.push(entry.serviceId);
          continue;
        }
        resumed.push(entry.serviceId);
      } catch {
        remaining.push(entry);
        skipped.push(entry.serviceId);
      }
    }
    state.paused = remaining;
  }

  state.updated_at = new Date().toISOString();
  writeShedState(state);

  return {
    pressure_level,
    recommended_jobs,
    paused,
    resumed,
    skipped,
    note: budget.ok ? budget.reason : 'budget_unavailable',
  };
}

/** Clamp configured subagent desire to live recommended_jobs. */
export function clampDesiredSubagents(desired: number, recommendedJobs: number): number {
  const want = Math.max(0, Math.floor(desired));
  const cap = Math.max(0, Math.floor(recommendedJobs));
  return Math.min(want, cap);
}
