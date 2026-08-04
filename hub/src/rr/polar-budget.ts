const POLARBUDGET_URL = (process.env.POLARBUDGET_URL ?? 'http://127.0.0.1:11060').replace(/\/$/, '');

const BUDGET_FETCH_TIMEOUT_MS = 5_000;
const LEASE_FETCH_TIMEOUT_MS = 10_000;

export interface PolarBudgetUnavailable {
  ok: false;
  reason: string;
  recommended_jobs: number;
}

export type PolarBudgetPressureLevel = 'plenty' | 'tight' | 'critical';

export interface PolarBudgetReport {
  ok: true;
  recommended_jobs: number;
  max_throughput_jobs?: number;
  reason: string;
  sampled_at?: string;
  logical_cpus?: number;
  pressure_level?: PolarBudgetPressureLevel;
  headroom_jobs?: number;
}

export type PolarBudgetSnapshot = PolarBudgetReport | PolarBudgetUnavailable;

export interface PolarBudgetLease {
  id: string;
  owner: string;
  estimated_jobs: number;
  created_at: string;
  expires_at: string;
}

export type AcquirePolarBudgetLeaseResult =
  | { ok: true; lease: PolarBudgetLease; recommended_jobs?: number }
  | { ok: false; status: number; message: string; recommended_jobs?: number };

/** Minimum concurrent AFK tasks when PolarBudget is unreachable (admission only). */
export const AFK_ADMISSION_UNAVAILABLE_FLOOR = 10;

/** Product target for concurrent AFK-solo IDE fleet (admission floor when budget is healthy). */
export const AFK_FLEET_TARGET = 10;

const DEFAULT_UNAVAILABLE: PolarBudgetUnavailable = {
  ok: false,
  reason: 'budget_unavailable',
  recommended_jobs: 1,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * AFK task admission cap from a PolarBudget snapshot.
 * When budget is healthy, never below AFK_FLEET_TARGET so the 10-IDE fleet can admit.
 * When unavailable, floors at AFK_ADMISSION_UNAVAILABLE_FLOOR (inject fan-out uses recommended_jobs separately).
 */
export function resolveAfkAdmissionCap(budget: PolarBudgetSnapshot): number {
  const jobs = Number(budget.recommended_jobs);
  const normalized = Number.isFinite(jobs) && jobs >= 1 ? Math.max(1, Math.floor(jobs)) : 1;
  if (budget.ok) return Math.max(normalized, AFK_FLEET_TARGET);
  return Math.max(AFK_ADMISSION_UNAVAILABLE_FLOOR, normalized);
}

function normalizeRecommendedJobs(value: unknown): number | undefined {
  const jobs = Number(value);
  if (!Number.isFinite(jobs) || jobs < 1) return undefined;
  return Math.max(1, Math.floor(jobs));
}

async function polarBudgetFetch(path: string, init?: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(`${POLARBUDGET_URL}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(
        init?.method && init.method !== 'GET' ? LEASE_FETCH_TIMEOUT_MS : BUDGET_FETCH_TIMEOUT_MS,
      ),
    });
  } catch {
    return undefined;
  }
}

async function fetchPolarBudgetOnce(): Promise<PolarBudgetSnapshot> {
  const response = await polarBudgetFetch('/api/budget');
  if (!response?.ok) {
    const status = response?.status;
    return {
      ...DEFAULT_UNAVAILABLE,
      reason: status ? `budget_http_${status}` : 'budget_unavailable',
    };
  }

  try {
    const body = await response.json() as Record<string, unknown>;
    const recommended_jobs = normalizeRecommendedJobs(body.recommended_jobs);
    if (recommended_jobs === undefined) return { ...DEFAULT_UNAVAILABLE };

    const pressure = body.pressure_level;
    return {
      ok: true,
      recommended_jobs,
      ...(normalizeRecommendedJobs(body.max_throughput_jobs) !== undefined
        ? { max_throughput_jobs: normalizeRecommendedJobs(body.max_throughput_jobs) }
        : {}),
      reason: typeof body.reason === 'string' ? body.reason : 'sampled',
      ...(typeof body.sampled_at === 'string' ? { sampled_at: body.sampled_at } : {}),
      ...(typeof body.logical_cpus === 'number' ? { logical_cpus: body.logical_cpus } : {}),
      ...(pressure === 'plenty' || pressure === 'tight' || pressure === 'critical'
        ? { pressure_level: pressure }
        : {}),
      ...(normalizeRecommendedJobs(body.headroom_jobs) !== undefined
        ? { headroom_jobs: normalizeRecommendedJobs(body.headroom_jobs) }
        : {}),
    };
  } catch {
    return { ...DEFAULT_UNAVAILABLE, reason: 'budget_parse_error' };
  }
}

/**
 * Sample PolarBudget. Never throws — returns a conservative fallback when unavailable.
 * Retries once on failure before falling back.
 */
export async function fetchPolarBudget(): Promise<PolarBudgetSnapshot> {
  const first = await fetchPolarBudgetOnce();
  if (first.ok) return first;

  await sleep(150);
  const second = await fetchPolarBudgetOnce();
  if (second.ok) return second;

  console.warn(
    `[polar-budget] unavailable after retry url=${POLARBUDGET_URL} reason=${second.reason ?? first.reason}`,
  );
  return second;
}

export async function acquirePolarBudgetLease(input: {
  owner: string;
  estimated_jobs: number;
  ttl_seconds?: number;
}): Promise<AcquirePolarBudgetLeaseResult> {
  const budget = await fetchPolarBudget();
  const recommended_jobs = budget.recommended_jobs;

  const response = await polarBudgetFetch('/api/lease', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: input.owner,
      estimated_jobs: input.estimated_jobs,
      ttl_seconds: input.ttl_seconds ?? 600,
    }),
  });
  if (!response) {
    return { ok: false, status: 503, message: 'budget_unavailable', recommended_jobs };
  }

  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    lease?: PolarBudgetLease;
    message?: string;
  };
  if (!response.ok || !body.ok || !body.lease?.id) {
    return {
      ok: false,
      status: response.status || 503,
      message: body.message ?? 'lease_denied',
      recommended_jobs,
    };
  }
  return { ok: true, lease: body.lease, recommended_jobs };
}

export async function releasePolarBudgetLease(leaseId: string): Promise<boolean> {
  const response = await polarBudgetFetch(`/api/lease/${encodeURIComponent(leaseId)}`, {
    method: 'DELETE',
  });
  if (!response?.ok) return false;
  const body = await response.json().catch(() => ({})) as { ok?: boolean };
  return body.ok === true;
}

export type PolarBudgetLeaseWaitEnqueueResult =
  | { ok: true; status: 'granted'; lease: PolarBudgetLease; position: 0 }
  | { ok: true; status: 'queued'; wait_id: string; position: number; wait_expires_at?: string }
  | { ok: false; status: number; message: string };

export async function enqueuePolarBudgetLeaseWait(input: {
  owner: string;
  estimated_jobs: number;
  ttl_seconds?: number;
  wait_ttl_seconds?: number;
}): Promise<PolarBudgetLeaseWaitEnqueueResult> {
  const response = await polarBudgetFetch('/api/lease/wait', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: input.owner,
      estimated_jobs: input.estimated_jobs,
      ttl_seconds: input.ttl_seconds ?? 600,
      wait_ttl_seconds: input.wait_ttl_seconds ?? 1800,
    }),
  });
  if (!response) {
    return { ok: false, status: 503, message: 'budget_unavailable' };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: typeof body.message === 'string' ? body.message : 'lease_wait_denied',
    };
  }
  if (body.status === 'granted' && body.lease && typeof body.lease === 'object') {
    return {
      ok: true,
      status: 'granted',
      lease: body.lease as PolarBudgetLease,
      position: 0,
    };
  }
  if (body.status === 'queued' && typeof body.wait_id === 'string') {
    return {
      ok: true,
      status: 'queued',
      wait_id: body.wait_id,
      position: Number(body.position ?? 1),
      ...(typeof body.wait_expires_at === 'string' ? { wait_expires_at: body.wait_expires_at } : {}),
    };
  }
  return { ok: false, status: response.status, message: 'invalid_wait_response' };
}

export async function pollPolarBudgetLeaseWait(waitId: string): Promise<
  | { ok: true; status: 'granted'; lease: PolarBudgetLease }
  | { ok: true; status: 'waiting'; position: number }
  | { ok: true; status: 'expired' }
  | { ok: false; message: string }
> {
  const response = await polarBudgetFetch(`/api/lease/wait/${encodeURIComponent(waitId)}`);
  if (!response?.ok) {
    return { ok: false, message: 'budget_unavailable' };
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (body.status === 'granted' && body.lease && typeof body.lease === 'object') {
    return { ok: true, status: 'granted', lease: body.lease as PolarBudgetLease };
  }
  if (body.status === 'waiting') {
    return { ok: true, status: 'waiting', position: Number(body.position ?? 1) };
  }
  if (body.status === 'expired') {
    return { ok: true, status: 'expired' };
  }
  return { ok: false, message: 'invalid_poll_response' };
}

/** Acquire lease immediately, or join PolarBudget 候补 queue and poll until granted. */
export async function acquirePolarBudgetLeaseOrWait(
  input: {
    owner: string;
    estimated_jobs: number;
    ttl_seconds?: number;
    wait_ttl_seconds?: number;
  },
  opts?: { maxWaitMs?: number; pollMs?: number },
): Promise<AcquirePolarBudgetLeaseResult> {
  const direct = await acquirePolarBudgetLease(input);
  if (direct.ok) return direct;

  const maxWaitMs = opts?.maxWaitMs ?? Number(process.env.RR_BUDGET_WAIT_MS ?? 1_800_000);
  if (maxWaitMs <= 0) return direct;

  const pollMs = opts?.pollMs ?? Number(process.env.RR_BUDGET_WAIT_POLL_MS ?? 2_000);
  const enqueued = await enqueuePolarBudgetLeaseWait(input);
  if (!enqueued.ok) {
    return { ok: false, status: enqueued.status, message: enqueued.message, recommended_jobs: direct.recommended_jobs };
  }
  if (enqueued.status === 'granted') {
    return { ok: true, lease: enqueued.lease, recommended_jobs: direct.recommended_jobs };
  }

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const polled = await pollPolarBudgetLeaseWait(enqueued.wait_id);
    if (!polled.ok) continue;
    if (polled.status === 'granted') {
      return { ok: true, lease: polled.lease, recommended_jobs: direct.recommended_jobs };
    }
    if (polled.status === 'expired') {
      return { ok: false, status: 408, message: 'lease_wait_expired', recommended_jobs: direct.recommended_jobs };
    }
  }
  return { ok: false, status: 408, message: 'lease_wait_timeout', recommended_jobs: direct.recommended_jobs };
}

export interface PolarBudgetPauseCandidate {
  ref: string;
  pid: number;
  pool: string;
  score: number;
  reason: string;
}

export async function fetchPauseRecommendations(limit = 20): Promise<{
  ok: boolean;
  pressure_level?: PolarBudgetPressureLevel;
  recommended_jobs?: number;
  candidates: PolarBudgetPauseCandidate[];
}> {
  const response = await polarBudgetFetch(`/api/recommendations/pause?limit=${encodeURIComponent(String(limit))}`);
  if (!response?.ok) return { ok: false, candidates: [] };
  const body = await response.json().catch(() => ({})) as {
    ok?: boolean;
    pressure_level?: PolarBudgetPressureLevel;
    recommended_jobs?: number;
    candidates?: PolarBudgetPauseCandidate[];
  };
  return {
    ok: body.ok === true,
    pressure_level: body.pressure_level,
    recommended_jobs: body.recommended_jobs,
    candidates: Array.isArray(body.candidates) ? body.candidates : [],
  };
}

/** Derive a local pressure guess when Budget is offline or old. */
export function inferPressureLevel(recommendedJobs: number): PolarBudgetPressureLevel {
  if (recommendedJobs <= 2) return 'critical';
  if (recommendedJobs < 6) return 'tight';
  return 'plenty';
}
