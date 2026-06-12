import { and, eq, inArray } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { HubSqlite } from '../persistence/db.js';
import { taskDependencies, tasks, type HubDb } from '../persistence/db.js';
import type { HubStore } from '../persistence/store.js';
import type { SafetyLimiter } from '../safety/limiter.js';
import type { ModuleAffinityService } from './affinity.js';
import type {
  HubClaimTaskInput,
  HubClaimTaskOutput,
  HubCompleteTaskInput,
  HubCompleteTaskOutput,
  HubCreateTaskInput,
  HubCreateTaskOutput,
  HubHeartbeatTaskInput,
  HubHeartbeatTaskOutput,
  HubListTasksInput,
  HubListTasksOutput,
  HubSplitTaskInput,
  HubSplitTaskOutput,
} from '../protocol/tasks.js';
import type { Task, TaskStatus, WorkflowStage } from '../types.js';
import { releaseExpiredTaskLeases } from './lease.js';
import { maybeAutocompleteParent } from './scheduler.js';

const IDEMPOTENCY_TTL_MS = 86_400_000;

export class TaskService {
  private limiter: SafetyLimiter | null = null;
  private affinityService: ModuleAffinityService | null = null;

  constructor(
    private readonly db: HubDb,
    private readonly sqlite: HubSqlite,
    private readonly store: HubStore,
  ) {}

  /** Inject limiter after construction to avoid circular deps. */
  setLimiter(limiter: SafetyLimiter): void {
    this.limiter = limiter;
  }

  setAffinityService(svc: ModuleAffinityService): void {
    this.affinityService = svc;
  }

  private loadDeps(taskId: string): string[] {
    return this.db
      .select({ dep: taskDependencies.dependsOnTaskId })
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all()
      .map((r) => r.dep);
  }

  private depsSatisfied(taskId: string): boolean {
    const deps = this.loadDeps(taskId);
    if (deps.length === 0) return true;
    const rows = this.db.select().from(tasks).where(inArray(tasks.id, deps)).all();
    const statusById = new Map(rows.map((r) => [r.id, r.status]));
    return deps.every((id) => statusById.get(id) === 'done');
  }

  /** True when there are no non-done child tasks (container parents wait for children). */
  private childrenSatisfied(taskId: string): boolean {
    const kids = this.db.select().from(tasks).where(eq(tasks.parentTaskId, taskId)).all();
    if (kids.length === 0) return true;
    return kids.every((k) => k.status === 'done');
  }

  private mapRow(row: typeof tasks.$inferSelect, dependsOn: string[]): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status as TaskStatus,
      owner_agent_id: row.ownerAgentId ?? null,
      parent_task_id: row.parentTaskId ?? null,
      depends_on: dependsOn,
      workflow_stage: row.workflowStage as WorkflowStage,
      priority: row.priority,
      module: row.module ?? null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      lease_expires_at: row.leaseExpiresAt ?? null,
    };
  }

  getTask(taskId: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) return undefined;
    return this.mapRow(row, this.loadDeps(taskId));
  }

  createTask(input: HubCreateTaskInput): HubCreateTaskOutput {
    if (input.idempotency_key) {
      const cached = this.store.getIdempotencyResult(input.idempotency_key);
      const revived = TaskService.reviveCreateOutput(cached);
      if (revived) return revived;
    }

    const now = new Date();
    const id = nanoid();
    const depends = input.depends_on ?? [];

    for (const depId of depends) {
      const depRow = this.db.select().from(tasks).where(eq(tasks.id, depId)).get();
      if (!depRow) {
        throw new Error(`depends_on_missing:${depId}`);
      }
    }

    if (input.parent_task_id) {
      const parentRow = this.db.select().from(tasks).where(eq(tasks.id, input.parent_task_id)).get();
      if (!parentRow) {
        throw new Error('parent_task_missing');
      }
    }

    this.db.transaction((tx) => {
      tx.insert(tasks)
        .values({
          id,
          status: 'open',
          ownerAgentId: null,
          parentTaskId: input.parent_task_id ?? null,
          workflowStage: input.workflow_stage,
          priority: input.priority,
          title: input.title,
          description: input.description ?? '',
          module: input.module ?? null,
          createdAt: now,
          updatedAt: now,
          leaseExpiresAt: null,
        })
        .run();

      for (const depId of depends) {
        tx.insert(taskDependencies).values({ taskId: id, dependsOnTaskId: depId }).run();
      }
    });

    const task = this.getTask(id);
    if (!task) {
      throw new Error('task_missing_after_create');
    }
    const out: HubCreateTaskOutput = { task };

    if (input.idempotency_key) {
      this.store.setIdempotencyResult(
        input.idempotency_key,
        TaskService.serializeCreateOutput(out),
        IDEMPOTENCY_TTL_MS,
      );
    }

    return out;
  }

  claimTask(input: HubClaimTaskInput): HubClaimTaskOutput {
    const now = new Date();
    releaseExpiredTaskLeases(this.db, now);

    // --- Compile gate: execute tasks require compile prerequisites to be done ---
    if (input.workflow_stage === 'execute' || !input.workflow_stage) {
      // Check handled inline below after candidate selection
    }

    // --- Scheduling strategy (three tiers) ---
    // 1. Module affinity: if the candidate task has a module tag AND another
    //    agent owns that module, yield to the owner (they have context in memory).
    // 2. Token balance: among non-module tasks, yield to the lighter agent.
    // 3. Fallback: normal priority + FIFO.

    const stageFilter = input.workflow_stage ?? null;

    // Fetch all ready tasks (not just LIMIT 1) so we can match by module affinity
    const readyStmt = this.sqlite.prepare(
      `SELECT id, module FROM tasks
       WHERE status = 'open'
         AND (
           SELECT COUNT(*) FROM task_dependencies d
           JOIN tasks dep ON dep.id = d.depends_on_task_id
           WHERE d.task_id = tasks.id AND dep.status != 'done'
         ) = 0
         AND (
           SELECT COUNT(*) FROM tasks child
           WHERE child.parent_task_id = tasks.id AND child.status != 'done'
         ) = 0
         AND (? IS NULL OR workflow_stage = ?)
       ORDER BY priority DESC, created_at ASC
       LIMIT 20`,
    );
    const readyRows = readyStmt.all(stageFilter, stageFilter) as { id: string; module: string | null }[];
    if (readyRows.length === 0) {
      return { task: null };
    }

    // --- Tier 1: Module affinity routing ---
    if (this.affinityService) {
      // Try to find a task whose module this agent owns
      const myModules = this.affinityService.getAgentModules(input.agent_id);
      const myModuleSet = new Set(myModules.map((m) => m.module));

      // Find the first task that matches one of our modules
      const affinityMatch = readyRows.find((r) => r.module && myModuleSet.has(r.module));
      if (affinityMatch) {
        return this.tryClaimRow(affinityMatch.id, input.agent_id, input.lease_duration_ms, now);
      }

      // This agent doesn't own any module-tagged tasks.
      // Walk through ready tasks to find one we're allowed to claim.
      for (const candidate of readyRows) {
        if (candidate.module) {
          const bestOwner = this.affinityService.findBestAgent(candidate.module);
          if (bestOwner && bestOwner.agent_id !== input.agent_id) {
            // Someone else owns this module — yield on first encounter
            return {
              task: null,
              scheduling_hint: {
                reason: 'module_affinity_yield',
                preferred_agent: bestOwner.agent_id,
                your_tokens: this.limiter?.getUsage(input.agent_id).tokens ?? 0,
                preferred_tokens: this.limiter?.getUsage(bestOwner.agent_id).tokens ?? 0,
              },
            };
          }
          // Module-tagged but no owner exists — claim it (first come, first served)
          const tokenYield = this.checkTokenYield(input.agent_id);
          if (tokenYield) return tokenYield;
          return this.tryClaimRow(candidate.id, input.agent_id, input.lease_duration_ms, now);
        }
        // Untagged task — apply token-balance yield, then claim
        const tokenYield = this.checkTokenYield(input.agent_id);
        if (tokenYield) return tokenYield;
        return this.tryClaimRow(candidate.id, input.agent_id, input.lease_duration_ms, now);
      }

      return { task: null };
    }

    // --- No affinity service: Tier 2 only (token balance) ---
    const tokenYield = this.checkTokenYield(input.agent_id);
    if (tokenYield) return tokenYield;

    return this.tryClaimRow(readyRows[0]!.id, input.agent_id, input.lease_duration_ms, now);
  }

  private checkTokenYield(agentId: string): HubClaimTaskOutput | null {
    if (!this.limiter) return null;
    const callerUsage = this.limiter.getUsage(agentId);
    if (callerUsage.tokens <= 0) return null;
    const ranked = this.limiter.rankByTokenAvailability();
    const activeRanked = ranked.filter((id) => {
      if (id === agentId) return false;
      return this.limiter!.getUsage(id).tokens > 0;
    });
    if (activeRanked.length === 0) return null;
    const lighterAgent = activeRanked[0]!;
    const lighterUsage = this.limiter.getUsage(lighterAgent);
    if (lighterUsage.tokens >= callerUsage.tokens) return null;
    return {
      task: null,
      scheduling_hint: {
        reason: 'token_budget_yield' as const,
        preferred_agent: lighterAgent,
        your_tokens: callerUsage.tokens,
        preferred_tokens: lighterUsage.tokens,
      },
    };
  }

  /**
   * Compile gate: if the task is in 'execute' stage and has a sibling/parent
   * in 'compile' stage that isn't done, block the claim.
   */
  private compileGateCheck(taskId: string): { blocked: boolean; reason?: string } {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row || row.workflowStage !== 'execute') return { blocked: false };

    if (row.parentTaskId) {
      const siblings = this.db.select().from(tasks)
        .where(eq(tasks.parentTaskId, row.parentTaskId)).all();
      const compileSiblings = siblings.filter(s => s.workflowStage === 'compile');
      const unfinished = compileSiblings.filter(s => s.status !== 'done');
      if (unfinished.length > 0) {
        return {
          blocked: true,
          reason: `compile_not_done: ${unfinished.length} compile task(s) pending`,
        };
      }
    }

    const deps = this.loadDeps(taskId);
    if (deps.length > 0) {
      const depRows = this.db.select().from(tasks).where(inArray(tasks.id, deps)).all();
      const compileDeps = depRows.filter(d => d.workflowStage === 'compile' && d.status !== 'done');
      if (compileDeps.length > 0) {
        return {
          blocked: true,
          reason: `compile_dep_not_done: ${compileDeps.map(d => d.id).join(',')}`,
        };
      }
    }

    return { blocked: false };
  }

  private tryClaimRow(
    taskId: string,
    agentId: string,
    leaseDurationMs: number,
    now: Date,
  ): HubClaimTaskOutput {
    const gate = this.compileGateCheck(taskId);
    if (gate.blocked) {
      return {
        task: null,
        scheduling_hint: {
          reason: gate.reason ?? 'compile_gate_blocked',
          preferred_agent: '',
          your_tokens: 0,
          preferred_tokens: 0,
        },
      };
    }
    const leaseUntil = new Date(now.getTime() + leaseDurationMs);
    const upd = this.db
      .update(tasks)
      .set({
        status: 'claimed',
        ownerAgentId: agentId,
        leaseExpiresAt: leaseUntil,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, taskId), eq(tasks.status, 'open')))
      .run();

    if (upd.changes !== 1) {
      return { task: null };
    }

    return { task: this.getTask(taskId) ?? null };
  }

  heartbeat(input: HubHeartbeatTaskInput): HubHeartbeatTaskOutput {
    const now = new Date();
    const row = this.db.select().from(tasks).where(eq(tasks.id, input.task_id)).get();
    if (!row) {
      throw new Error('task_not_found');
    }
    if (row.status !== 'claimed' || row.ownerAgentId !== input.agent_id) {
      throw new Error('heartbeat_denied');
    }

    const extendBy = input.lease_extend_ms ?? 60_000;
    const base = row.leaseExpiresAt?.getTime() ?? now.getTime();
    const nextLease = new Date(Math.max(now.getTime(), base + extendBy));

    this.db
      .update(tasks)
      .set({ leaseExpiresAt: nextLease, updatedAt: now })
      .where(eq(tasks.id, input.task_id))
      .run();

    const task = this.getTask(input.task_id);
    if (!task) {
      throw new Error('task_missing');
    }
    return { task };
  }

  completeTask(input: HubCompleteTaskInput): HubCompleteTaskOutput {
    if (input.idempotency_key) {
      const cached = this.store.getIdempotencyResult(input.idempotency_key);
      const revived = TaskService.reviveCompleteOutput(cached);
      if (revived) return revived;
    }

    const now = new Date();
    const row = this.db.select().from(tasks).where(eq(tasks.id, input.task_id)).get();
    if (!row) {
      throw new Error('task_not_found');
    }
    if (row.status !== 'claimed' || row.ownerAgentId !== input.agent_id) {
      throw new Error('complete_denied');
    }

    this.db
      .update(tasks)
      .set({
        status: 'done',
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, input.task_id))
      .run();

    maybeAutocompleteParent(this.db, input.task_id);

    // Build implicit module affinity: completing a module-tagged task
    // earns the agent ownership of that module for future scheduling.
    if (this.affinityService && row.module) {
      this.affinityService.recordCompletion(input.agent_id, row.module);
    }

    const task = this.getTask(input.task_id);
    if (!task) {
      throw new Error('task_missing');
    }

    const out: HubCompleteTaskOutput = { task };
    if (input.idempotency_key) {
      this.store.setIdempotencyResult(
        input.idempotency_key,
        TaskService.serializeCompleteOutput(out),
        IDEMPOTENCY_TTL_MS,
      );
    }
    return out;
  }

  listTasks(input: HubListTasksInput): HubListTasksOutput {
    const limit = Math.min(input.limit ?? 100, 500);
    let rows = this.db.select().from(tasks).all();

    if (input.status) {
      rows = rows.filter((r) => r.status === input.status);
    }
    if (input.workflow_stage) {
      rows = rows.filter((r) => r.workflowStage === input.workflow_stage);
    }
    if (input.owner_agent_id) {
      rows = rows.filter((r) => r.ownerAgentId === input.owner_agent_id);
    }
    if (input.ready_only) {
      rows = rows.filter(
        (r) => r.status === 'open' && this.depsSatisfied(r.id) && this.childrenSatisfied(r.id),
      );
    }

    rows.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    rows = rows.slice(0, limit);

    return {
      tasks: rows.map((r) => this.mapRow(r, this.loadDeps(r.id))),
    };
  }

  splitTask(input: HubSplitTaskInput): HubSplitTaskOutput {
    if (input.idempotency_key) {
      const cached = this.store.getIdempotencyResult(input.idempotency_key);
      const revived = TaskService.reviveSplitOutput(cached);
      if (revived) return revived;
    }

    const parent = this.getTask(input.parent_task_id);
    if (!parent) {
      throw new Error('parent_missing');
    }

    const now = new Date();
    const childIds: string[] = [];

    this.db.transaction((tx) => {
      for (const spec of input.children) {
        const cid = nanoid();
        childIds.push(cid);
        tx.insert(tasks)
          .values({
            id: cid,
            status: 'open',
            ownerAgentId: null,
            parentTaskId: input.parent_task_id,
            workflowStage: spec.workflow_stage ?? parent.workflow_stage,
            priority: spec.priority ?? parent.priority,
            title: spec.title,
            description: spec.description ?? '',
            module: parent.module,
            createdAt: now,
            updatedAt: now,
            leaseExpiresAt: null,
          })
          .run();
      }

      tx.update(tasks).set({ updatedAt: now }).where(eq(tasks.id, input.parent_task_id)).run();
    });

    const children = childIds.map((id) => this.getTask(id)).filter((t): t is Task => Boolean(t));
    const refreshedParent = this.getTask(input.parent_task_id);
    if (!refreshedParent) {
      throw new Error('parent_missing_after_split');
    }

    const out: HubSplitTaskOutput = { parent: refreshedParent, children };
    if (input.idempotency_key) {
      this.store.setIdempotencyResult(
        input.idempotency_key,
        TaskService.serializeSplitOutput(out),
        IDEMPOTENCY_TTL_MS,
      );
    }
    return out;
  }

  blockTask(agentId: string, taskId: string): Task {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) {
      throw new Error('task_not_found');
    }
    if (row.ownerAgentId && row.ownerAgentId !== agentId) {
      throw new Error('block_denied');
    }
    const now = new Date();
    this.db
      .update(tasks)
      .set({
        status: 'blocked',
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .run();
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error('task_missing');
    }
    return task;
  }

  cancelTask(agentId: string, taskId: string): Task {
    const row = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!row) {
      throw new Error('task_not_found');
    }
    if (row.ownerAgentId && row.ownerAgentId !== agentId) {
      throw new Error('cancel_denied');
    }
    const now = new Date();
    this.db
      .update(tasks)
      .set({
        status: 'cancelled',
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .run();
    const task = this.getTask(taskId);
    if (!task) {
      throw new Error('task_missing');
    }
    return task;
  }

  private static serializeTask(task: Task): Record<string, unknown> {
    return {
      ...task,
      created_at: task.created_at.toISOString(),
      updated_at: task.updated_at.toISOString(),
      lease_expires_at: task.lease_expires_at ? task.lease_expires_at.toISOString() : null,
    };
  }

  private static reviveTask(value: unknown): Task | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if (
      typeof v.id !== 'string' ||
      typeof v.status !== 'string' ||
      !('depends_on' in v) ||
      !Array.isArray(v.depends_on) ||
      typeof v.workflow_stage !== 'string' ||
      typeof v.priority !== 'number'
    ) {
      return null;
    }
    const ca = v.created_at;
    const ua = v.updated_at;
    const le = v.lease_expires_at;
    if (typeof ca !== 'string' || typeof ua !== 'string') return null;

    return {
      id: v.id,
      title: typeof v.title === 'string' ? v.title : '',
      description: typeof v.description === 'string' ? v.description : '',
      status: v.status as TaskStatus,
      owner_agent_id: typeof v.owner_agent_id === 'string' ? v.owner_agent_id : null,
      parent_task_id: typeof v.parent_task_id === 'string' ? v.parent_task_id : null,
      depends_on: v.depends_on as string[],
      workflow_stage: v.workflow_stage as WorkflowStage,
      priority: v.priority,
      module: typeof v.module === 'string' ? v.module : null,
      created_at: new Date(ca),
      updated_at: new Date(ua),
      lease_expires_at: typeof le === 'string' ? new Date(le) : null,
    };
  }

  private static serializeCreateOutput(out: HubCreateTaskOutput): unknown {
    return { task: TaskService.serializeTask(out.task) };
  }

  private static reviveCreateOutput(value: unknown): HubCreateTaskOutput | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const task = TaskService.reviveTask(v.task);
    if (!task) return null;
    return { task };
  }

  private static serializeCompleteOutput(out: HubCompleteTaskOutput): unknown {
    return { task: TaskService.serializeTask(out.task) };
  }

  private static reviveCompleteOutput(value: unknown): HubCompleteTaskOutput | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const task = TaskService.reviveTask(v.task);
    if (!task) return null;
    return { task };
  }

  private static serializeSplitOutput(out: HubSplitTaskOutput): unknown {
    return {
      parent: TaskService.serializeTask(out.parent),
      children: out.children.map((t) => TaskService.serializeTask(t)),
    };
  }

  private static reviveSplitOutput(value: unknown): HubSplitTaskOutput | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    const parent = TaskService.reviveTask(v.parent);
    if (!parent) return null;
    if (!Array.isArray(v.children)) return null;
    const children = v.children.map((c) => TaskService.reviveTask(c)).filter((t): t is Task => Boolean(t));
    if (children.length !== v.children.length) return null;
    return { parent, children };
  }
}
