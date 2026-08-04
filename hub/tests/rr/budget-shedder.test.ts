import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clampDesiredSubagents,
  filterPauseTargets,
  isAuthorityServiceId,
  runBudgetShedderTick,
  readShedState,
} from '../../src/rr/afk/budget-shedder.js';

describe('budget-shedder', () => {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env.RR_AFK_ROOT;
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  });

  it('never pauses authority service ids (C7)', () => {
    expect(isAuthorityServiceId('polarcop-hub')).toBe(true);
    expect(isAuthorityServiceId('polar-budget')).toBe(true);
    expect(isAuthorityServiceId('polar-process')).toBe(true);
    expect(isAuthorityServiceId('preview-toy')).toBe(false);
    const filtered = filterPauseTargets([
      { ref: 'polarcop-hub', reason: 'x' },
      { ref: 'preview-toy', reason: 'y' },
    ]);
    expect(filtered.map((t) => t.serviceId)).toEqual(['preview-toy']);
  });

  it('clamps desired subagents to recommended_jobs (C5)', () => {
    expect(clampDesiredSubagents(8, 3)).toBe(3);
    expect(clampDesiredSubagents(2, 10)).toBe(2);
    expect(clampDesiredSubagents(-1, 5)).toBe(0);
  });

  it('pauses pausable services under critical and resumes under plenty (C6)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-shed-'));
    roots.push(root);
    process.env.RR_AFK_ROOT = root;

    const stopped: string[] = [];
    const started: string[] = [];

    const critical = await runBudgetShedderTick({
      fetchBudget: async () => ({
        ok: true,
        recommended_jobs: 1,
        pressure_level: 'critical',
        reason: 'test-critical',
      }),
      fetchRecommendations: async () => ({
        ok: true,
        pressure_level: 'critical',
        candidates: [
          { ref: 'polarcop-hub', pid: 1, pool: 'service_fg', score: 1, reason: 'bad' },
          { ref: 'preview-toy', pid: 2, pool: 'service_bg', score: 80, reason: 'ok' },
        ],
      }),
      stopService: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
      startService: async (id) => {
        started.push(id);
        return { ok: true };
      },
    });

    expect(critical.pressure_level).toBe('critical');
    expect(stopped).toEqual(['preview-toy']);
    expect(readShedState().paused.map((p) => p.serviceId)).toEqual(['preview-toy']);

    const plenty = await runBudgetShedderTick({
      fetchBudget: async () => ({
        ok: true,
        recommended_jobs: 12,
        pressure_level: 'plenty',
        reason: 'test-plenty',
      }),
      fetchRecommendations: async () => ({ ok: true, candidates: [] }),
      stopService: async (id) => {
        stopped.push(id);
        return { ok: true };
      },
      startService: async (id) => {
        started.push(id);
        return { ok: true };
      },
    });

    expect(plenty.resumed).toEqual(['preview-toy']);
    expect(started).toEqual(['preview-toy']);
    expect(readShedState().paused).toEqual([]);
  });
});
