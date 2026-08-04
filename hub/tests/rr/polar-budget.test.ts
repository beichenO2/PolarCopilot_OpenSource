import { afterEach, describe, expect, it, vi } from 'vitest';
import { canSpawnAgent } from '../../src/rr/afk/budget-gate.js';
import {
  acquirePolarBudgetLease,
  AFK_ADMISSION_UNAVAILABLE_FLOOR,
  AFK_FLEET_TARGET,
  fetchPolarBudget,
  releasePolarBudgetLease,
  resolveAfkAdmissionCap,
} from '../../src/rr/polar-budget.js';
import { resolveInjectFanOutCap } from '../../src/rr/orchestrator/runner.js';

describe('polar-budget client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns recommended_jobs from GET /api/budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      recommended_jobs: 6,
      max_throughput_jobs: 8,
      reason: 'cool',
    }), { status: 200 })));

    const budget = await fetchPolarBudget();
    expect(budget).toEqual({
      ok: true,
      recommended_jobs: 6,
      max_throughput_jobs: 8,
      reason: 'cool',
    });
  });

  it('falls back conservatively when budget is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    const budget = await fetchPolarBudget();
    expect(budget).toMatchObject({
      ok: false,
      reason: 'budget_unavailable',
      recommended_jobs: 1,
    });
  });

  it('retries once before falling back when budget is unavailable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchPolarBudget();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolveAfkAdmissionCap uses max(recommended_jobs, AFK_FLEET_TARGET) when budget is ok', () => {
    expect(AFK_FLEET_TARGET).toBe(10);
    expect(resolveAfkAdmissionCap({ ok: true, recommended_jobs: 14, reason: 'cool' })).toBe(14);
    expect(resolveAfkAdmissionCap({ ok: true, recommended_jobs: 8, reason: 'warm' })).toBe(10);
    expect(resolveAfkAdmissionCap({ ok: true, recommended_jobs: 1, reason: 'tight' })).toBe(10);
  });

  it('resolveAfkAdmissionCap floors at AFK_ADMISSION_UNAVAILABLE_FLOOR when budget unavailable', () => {
    expect(AFK_ADMISSION_UNAVAILABLE_FLOOR).toBe(10);
    expect(resolveAfkAdmissionCap({ ok: false, reason: 'budget_unavailable', recommended_jobs: 1 }))
      .toBe(10);
  });

  it('resolveInjectFanOutCap follows recommended_jobs when budget is ok', () => {
    expect(resolveInjectFanOutCap({ ok: true, recommended_jobs: 8, reason: 'warm' })).toBe(8);
    expect(resolveInjectFanOutCap({ ok: true, recommended_jobs: 14, reason: 'cool' })).toBe(14);
    expect(resolveInjectFanOutCap(4)).toBe(4);
    expect(resolveInjectFanOutCap(14)).toBe(14);
  });

  it('resolveInjectFanOutCap is conservative when budget unavailable', () => {
    expect(resolveInjectFanOutCap({ ok: false, reason: 'budget_unavailable', recommended_jobs: 1 })).toBe(1);
    expect(resolveInjectFanOutCap(0)).toBe(1);
    expect(resolveInjectFanOutCap(undefined)).toBe(1);
    expect(resolveInjectFanOutCap(Number.NaN)).toBe(1);
  });

  it('resolveInjectFanOutCap honors AFK_INJECT_UNAVAILABLE_CAP env', () => {
    const prev = process.env.AFK_INJECT_UNAVAILABLE_CAP;
    process.env.AFK_INJECT_UNAVAILABLE_CAP = '2';
    try {
      expect(resolveInjectFanOutCap({ ok: false, reason: 'budget_unavailable', recommended_jobs: 1 })).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.AFK_INJECT_UNAVAILABLE_CAP;
      else process.env.AFK_INJECT_UNAVAILABLE_CAP = prev;
    }
  });

  it('acquires and releases a lease', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/budget')) {
        return new Response(JSON.stringify({ recommended_jobs: 4, reason: 'warm' }), { status: 200 });
      }
      if (url.endsWith('/api/lease') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          lease: {
            id: 'lease-1',
            owner: 'rr-spawn',
            estimated_jobs: 8,
            created_at: '2026-07-30T00:00:00.000Z',
            expires_at: '2026-07-30T00:10:00.000Z',
          },
        }), { status: 200 });
      }
      if (url.endsWith('/api/lease/lease-1') && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const acquired = await acquirePolarBudgetLease({ owner: 'rr-spawn', estimated_jobs: 8 });
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      expect(acquired.lease.id).toBe('lease-1');
      expect(await releasePolarBudgetLease(acquired.lease.id)).toBe(true);
    }
  });

  it('does not throw when lease acquisition fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/budget')) {
        return new Response(JSON.stringify({ recommended_jobs: 2, reason: 'warm' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, message: 'lease capacity full' }), { status: 503 });
    }));

    const result = await acquirePolarBudgetLease({ owner: 'rr-spawn', estimated_jobs: 8 });
    expect(result).toEqual({
      ok: false,
      status: 503,
      message: 'lease capacity full',
      recommended_jobs: 2,
    });
  });
});

describe('budget gate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('allows spawn within recommended_jobs without a lease', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      recommended_jobs: 4,
      reason: 'cool',
    }), { status: 200 })));

    const result = await canSpawnAgent({ estimatedJobs: 2 });
    expect(result).toMatchObject({
      allowed: true,
      reason: 'within_recommended_jobs',
      recommended_jobs: 10,
    });
  });

  it('allows fleet spawn owners within admission floor without lease', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      recommended_jobs: 2,
      reason: 'hot',
    }), { status: 200 })));

    const result = await canSpawnAgent({
      estimatedJobs: 5,
      owner: 'rr-spawn-queue:fleet-test',
    });
    expect(result).toMatchObject({
      allowed: true,
      reason: 'fleet_admission_floor',
      recommended_jobs: 10,
    });
  });

  it('allows fleet spawn via rr-afk-spawn owner within admission floor without lease', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      recommended_jobs: 2,
      reason: 'hot',
    }), { status: 200 })));

    const result = await canSpawnAgent({
      estimatedJobs: 5,
      owner: 'rr-afk-spawn:fleet-task',
      acquireLease: true,
      waitForLeaseMs: 0,
    });
    expect(result).toMatchObject({
      allowed: true,
      reason: 'fleet_admission_floor',
      recommended_jobs: 10,
    });
  });

  it('fail-opens fleet spawn when PolarBudget unavailable without lease wait', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    const result = await canSpawnAgent({
      estimatedJobs: 1,
      owner: 'rr-spawn-queue:fleet-offline',
      acquireLease: true,
      waitForLeaseMs: 1_800_000,
    });
    expect(result).toMatchObject({
      allowed: true,
      reason: 'budget_unavailable_admission_floor',
      recommended_jobs: 10,
      budget: { ok: false, reason: 'budget_unavailable', recommended_jobs: 1 },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('/api/lease'))).toBe(true);
  });

  it('blocks non-fleet spawn above recommended_jobs unless lease succeeds', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/budget')) {
        return new Response(JSON.stringify({ recommended_jobs: 2, reason: 'hot' }), { status: 200 });
      }
      if (url.endsWith('/api/lease') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          lease: {
            id: 'lease-2',
            owner: 'rr-spawn',
            estimated_jobs: 5,
            created_at: '2026-07-30T00:00:00.000Z',
            expires_at: '2026-07-30T00:10:00.000Z',
          },
        }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const blocked = await canSpawnAgent({ estimatedJobs: 5 });
    expect(blocked).toMatchObject({
      allowed: false,
      reason: 'estimated_jobs_exceeds_recommended',
      recommended_jobs: 2,
    });

    const leased = await canSpawnAgent({ estimatedJobs: 5, acquireLease: true, waitForLeaseMs: 0 });
    expect(leased).toMatchObject({
      allowed: true,
      reason: 'lease_acquired',
      recommended_jobs: 2,
      leaseId: 'lease-2',
    });
  });
});
