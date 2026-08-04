import {
  acquirePolarBudgetLease,
  acquirePolarBudgetLeaseOrWait,
  fetchPolarBudget,
  resolveAfkAdmissionCap,
  type PolarBudgetSnapshot,
} from '../polar-budget.js';

export interface CanSpawnAgentInput {
  estimatedJobs: number;
  owner?: string;
  /** Attempt a build lease when estimated jobs exceed the current recommendation. */
  acquireLease?: boolean;
  ttlSeconds?: number;
  /** When acquire fails, join PolarBudget 候补 and poll (ms). Default RR_BUDGET_WAIT_MS or 30min. Set 0 to disable. */
  waitForLeaseMs?: number;
}

export interface CanSpawnAgentResult {
  allowed: boolean;
  reason: string;
  recommended_jobs: number;
  budget: PolarBudgetSnapshot;
  leaseId?: string;
}

function isFleetSpawnOwner(owner?: string): boolean {
  return Boolean(
    owner?.startsWith('rr-spawn') || owner?.startsWith('rr-afk-spawn'),
  );
}

/**
 * Gate cursor-agent spawns against PolarBudget `recommended_jobs`.
 * Fleet owners (rr-spawn* / rr-afk-spawn*) may proceed within resolveAfkAdmissionCap without lease wait.
 * When PolarBudget is unreachable, fail-open to admission floor (no mandatory lease / 候补 block).
 * When `acquireLease` + capacity full → optional PolarBudget wait queue (候补).
 */
export async function canSpawnAgent(input: CanSpawnAgentInput): Promise<CanSpawnAgentResult> {
  const budget = await fetchPolarBudget();
  const admissionCap = resolveAfkAdmissionCap(budget);
  const recommended_jobs = budget.recommended_jobs;
  const estimatedJobs = Math.max(1, Math.floor(input.estimatedJobs));
  const fleetOwner = isFleetSpawnOwner(input.owner);

  if (!budget.ok && estimatedJobs <= admissionCap) {
    return {
      allowed: true,
      reason: 'budget_unavailable_admission_floor',
      recommended_jobs: admissionCap,
      budget,
    };
  }

  if (estimatedJobs <= recommended_jobs) {
    return {
      allowed: true,
      reason: 'within_recommended_jobs',
      recommended_jobs: admissionCap,
      budget,
    };
  }

  if (fleetOwner && estimatedJobs <= admissionCap) {
    return {
      allowed: true,
      reason: 'fleet_admission_floor',
      recommended_jobs: admissionCap,
      budget,
    };
  }

  if (input.acquireLease) {
    const waitMs = input.waitForLeaseMs ?? Number(process.env.RR_BUDGET_WAIT_MS ?? 1_800_000);
    const owner = input.owner ?? 'rr-spawn';
    const leaseInput = {
      owner,
      estimated_jobs: estimatedJobs,
      ttl_seconds: input.ttlSeconds,
    };

    let lease;
    if (waitMs > 0) {
      const enqueued = await acquirePolarBudgetLeaseOrWait(leaseInput, { maxWaitMs: waitMs });
      lease = enqueued;
    } else {
      lease = await acquirePolarBudgetLease(leaseInput);
    }

    if (lease.ok) {
      const reason = waitMs > 0 ? 'lease_acquired_or_wait' : 'lease_acquired';
      return {
        allowed: true,
        reason,
        recommended_jobs: lease.recommended_jobs ?? recommended_jobs,
        budget,
        leaseId: lease.lease.id,
      };
    }
    return {
      allowed: false,
      reason: lease.message,
      recommended_jobs: lease.recommended_jobs ?? recommended_jobs,
      budget,
    };
  }

  return {
    allowed: false,
    reason: 'estimated_jobs_exceeds_recommended',
    recommended_jobs,
    budget,
  };
}

export { acquirePolarBudgetLeaseOrWait };
