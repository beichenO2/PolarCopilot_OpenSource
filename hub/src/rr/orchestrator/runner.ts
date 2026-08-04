import { clampDesiredSubagents, runBudgetShedderTick } from '../afk/budget-shedder.js';
import { acquireTaskLock, releaseTaskLock } from '../afk/store.js';
import { fetchPolarBudget, type PolarBudgetSnapshot } from '../polar-budget.js';
import { readActiveTaskSnapshots, readAfkSnapshot } from './afk-state.js';
import { isOrchestratorEnabled } from './toggle.js';
import { RrHubClient } from './hub-client.js';
import { contentHash, planNextAction } from './planner.js';
import {
  appendEvent,
  bumpTaskInjection,
  getTaskOrchestratorState,
  loadState,
  plannerStateForTask,
  saveState,
} from './state.js';
import { mergeManagedSubagentIds, planSubagentPool } from './subagent-pool.js';
import { readAllowNewSubagents } from './config.js';
import type { AfkSnapshot, OrchestratorConfig, OrchestratorState, OrchestratorTick, PlannerAction } from './types.js';
import type { RrSession } from '../types.js';

type FanOutAction = Extract<PlannerAction, { kind: 'inject' | 'wake' | 'dispatch' }>;

function isFanOutAction(action: PlannerAction): action is FanOutAction {
  return action.kind === 'inject' || action.kind === 'wake' || action.kind === 'dispatch';
}

/** Inject/wake/dispatch fan-out cap — throttled by PolarBudget.recommended_jobs (admission stays separate). */
export function resolveInjectFanOutCap(input?: PolarBudgetSnapshot | number): number {
  const unavailableCap = (() => {
    const env = Number(process.env.AFK_INJECT_UNAVAILABLE_CAP);
    return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 1;
  })();

  if (typeof input === 'number') {
    const jobs = Number(input);
    if (!Number.isFinite(jobs) || jobs < 1) return unavailableCap;
    return Math.max(1, Math.floor(jobs));
  }
  if (input && typeof input === 'object') {
    if (!input.ok) return unavailableCap;
    const jobs = Number(input.recommended_jobs);
    if (!Number.isFinite(jobs) || jobs < 1) return unavailableCap;
    return Math.max(1, Math.floor(jobs));
  }
  return unavailableCap;
}

export async function fetchInjectFanOutCap(): Promise<number> {
  try {
    const budget = await fetchPolarBudget();
    return resolveInjectFanOutCap(budget);
  } catch {
    return resolveInjectFanOutCap({ ok: false, reason: 'budget_unavailable', recommended_jobs: 1 });
  }
}

export function sortFanOutCandidates<T extends { taskId: string; lastInjectedAt: number | null }>(
  candidates: T[],
): T[] {
  return [...candidates].sort((left, right) => {
    const leftAt = left.lastInjectedAt ?? 0;
    const rightAt = right.lastInjectedAt ?? 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return left.taskId.localeCompare(right.taskId);
  });
}

interface PreparedTaskTick {
  taskId: string;
  afk: AfkSnapshot;
  masterSessionId: string;
  action: PlannerAction;
  tick: OrchestratorTick;
  lastInjectedAt: number | null;
}

function resolveMasterForTask(
  sessions: RrSession[],
  config: OrchestratorConfig,
  afk: AfkSnapshot,
): RrSession | null {
  const masterSessionId = afk.primarySummary?.master_session_id ?? null;
  if (masterSessionId) {
    const bound = sessions.find((session) => session.sessionId === masterSessionId && !session.isSubagent);
    if (bound) return bound;
  }
  if (config.masterSessionId && !masterSessionId) {
    return sessions.find((session) => session.sessionId === config.masterSessionId && !session.isSubagent) ?? null;
  }
  if (config.masterSessionName && !masterSessionId) {
    return sessions.find((session) => session.name === config.masterSessionName && !session.isSubagent) ?? null;
  }
  return null;
}

function emitLoopSentinel(config: OrchestratorConfig, tick: OrchestratorTick): void {
  if (!config.loopBridge) return;
  const payload = JSON.stringify({
    sessionId: tick.sessionId,
    taskId: tick.taskId ?? null,
    action: tick.action.kind,
    reason: 'reason' in tick.action ? tick.action.reason : '',
    prompt: tick.action.kind === 'inject' || tick.action.kind === 'wake' ? tick.action.content : '',
  });
  process.stdout.write(`${config.loopSentinelPrefix} ${payload}\n`);
}

async function executeAction(
  client: RrHubClient,
  config: OrchestratorConfig,
  sessionId: string,
  action: PlannerAction,
): Promise<void> {
  switch (action.kind) {
    case 'inject':
      await client.injectMessage(sessionId, action.content);
      break;
    case 'wake':
      await client.respawnCursor(sessionId, config.projectRoot, true);
      await client.injectMessage(sessionId, action.content);
      break;
    case 'dispatch':
      await client.dispatchTask(sessionId, action.targetSessionId, action.content);
      break;
    default:
      break;
  }
}

async function maintainSubagentPool(
  client: RrHubClient,
  config: OrchestratorConfig,
  state: OrchestratorState,
  sessions: RrSession[],
  now: number,
): Promise<OrchestratorState> {
  if (!config.maintainSubagentPool) return state;

  const effectiveConfig = {
    ...config,
    allowNewSubagents: readAllowNewSubagents(),
  };

  const managedIds = mergeManagedSubagentIds(
    effectiveConfig.managedSubagentIds,
    state.managedSubagentIds,
  );
  const lastRecoveryAt = state.lastPoolRecoveryAt ?? {};
  const budget = await fetchPolarBudget();
  const desiredCount = clampDesiredSubagents(
    effectiveConfig.desiredSubagents ?? 0,
    budget.recommended_jobs,
  );
  const plan = planSubagentPool(
    sessions,
    { managedIds, lastRecoveryAt },
    {
      desiredCount,
      allowNewSubagents: effectiveConfig.allowNewSubagents !== false,
      recoveryCooldownMs: effectiveConfig.subagentRecoveryCooldownMs ?? 45_000,
      pruneAfterMs: effectiveConfig.subagentPruneAfterMs ?? 15 * 60_000,
    },
    now,
  );

  const nextManagedIds = [...plan.managedIds];
  const knownSessions = new Map(sessions.map((session) => [session.sessionId, session]));
  let lastAction: string | null = null;
  for (const action of plan.actions) {
    if (action.kind === 'respawn') {
      await client.respawnCursor(action.sessionId, effectiveConfig.projectRoot, effectiveConfig.subagentHeadless ?? true);
      lastRecoveryAt[action.sessionId] = now;
      lastAction = `respawn:${action.sessionId}`;
      continue;
    }
    if (action.kind === 'prune') {
      await client.deleteSession(action.sessionId);
      delete lastRecoveryAt[action.sessionId];
      lastAction = `prune:${action.sessionId}`;
      continue;
    }

    if (!readAllowNewSubagents()) {
      lastAction = 'create:blocked';
      continue;
    }
    const created = await client.createSubagent(
      `Rr Agent · 池${nextManagedIds.length + 1}`,
      effectiveConfig.projectRoot,
      effectiveConfig.subagentHeadless ?? true,
    );
    nextManagedIds.push(created.sessionId);
    knownSessions.set(created.sessionId, created);
    lastAction = 'create';
  }

  const poolSessions = nextManagedIds
    .map((sessionId) => knownSessions.get(sessionId))
    .filter((session): session is RrSession => Boolean(session));
  return {
    ...state,
    managedSubagentIds: nextManagedIds,
    lastPoolRecoveryAt: lastRecoveryAt,
    lastPoolAction: lastAction,
    pool: {
      desired: desiredCount,
      managed: nextManagedIds.length,
      online: poolSessions.filter((session) => session.online && session.status !== 'offline').length,
      waiting: poolSessions.filter((session) => session.waiting || session.status === 'waiting').length,
      offline: poolSessions.filter((session) => !session.online || session.status === 'offline').length,
    },
  };
}

function anyActiveAfkWork(config: OrchestratorConfig): boolean {
  const active = readActiveTaskSnapshots(config);
  if (active.length > 0) return true;
  const legacy = readAfkSnapshot(config);
  return legacy.active && !legacy.paused && !legacy.done;
}

export class RrOrchestratorRunner {
  private readonly client: RrHubClient;
  private readonly config: OrchestratorConfig;
  private stopped = false;
  private tickInFlight = false;
  private lastTickStartedAt = 0;
  private sse: { close: () => void } | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.client = new RrHubClient({ hubUrl: config.hubUrl });
  }

  stop(): void {
    this.stopped = true;
    this.sse?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async prepareTaskTick(
    state: OrchestratorState,
    sessions: RrSession[],
    afk: AfkSnapshot,
    now: number,
  ): Promise<PreparedTaskTick | null> {
    const taskId = afk.taskId ?? afk.primarySummary?.task_id ?? null;
    if (!taskId) return null;

    const taskSlice = getTaskOrchestratorState(state, taskId);
    if (taskSlice.paused) return null;

    if (afk.paused || afk.done) {
      return null;
    }

    const master = resolveMasterForTask(sessions, this.config, afk);
    if (!master) return null;

    const detail = await this.client.sessionDetail(master.sessionId);
    const listedSubagents = await this.client.listSubagents(master.sessionId);
    const managedSet = new Set(state.managedSubagentIds);
    const subagents = this.config.maintainSubagentPool
      ? listedSubagents.filter((agent) => managedSet.has(agent.sessionId))
      : listedSubagents;

    const action = planNextAction({
      config: this.config,
      state: plannerStateForTask(state, taskId),
      afk,
      session: detail.session,
      history: detail.history,
      subagents,
    }, now);

    return {
      taskId,
      afk,
      masterSessionId: master.sessionId,
      action,
      tick: {
        at: now,
        sessionId: master.sessionId,
        taskId,
        action,
      },
      lastInjectedAt: taskSlice.lastInjectedAt,
    };
  }

  private async commitTaskTick(
    state: OrchestratorState,
    prepared: PreparedTaskTick,
    now: number,
  ): Promise<{ state: OrchestratorState; tick: OrchestratorTick }> {
    const { taskId, action, tick } = prepared;
    appendEvent(this.config.logPath, tick);

    let nextState = {
      ...state,
      lastTickAt: now,
    };

    if (isFanOutAction(action)) {
      if (!acquireTaskLock(taskId)) {
        const lockedTick: OrchestratorTick = {
          ...tick,
          action: { kind: 'noop', reason: `task_lock_held:${taskId}` },
        };
        appendEvent(this.config.logPath, lockedTick);
        return { state: nextState, tick: lockedTick };
      }
      try {
        await executeAction(this.client, this.config, prepared.masterSessionId, action);
        const hash = (action.kind === 'inject' || action.kind === 'wake') && 'content' in action
          ? contentHash(action.content)
          : undefined;
        nextState = bumpTaskInjection(
          nextState,
          taskId,
          now,
          this.config.maxInjectionsPerHour,
          prepared.masterSessionId,
          action.kind,
          hash,
        );
        emitLoopSentinel(this.config, tick);
      } finally {
        releaseTaskLock(taskId);
      }
    }

    return { state: nextState, tick };
  }

  private recordDeferredFanOut(
    prepared: PreparedTaskTick,
    cap: number,
    selectedCount: number,
    totalCandidates: number,
  ): OrchestratorTick {
    const deferredTick: OrchestratorTick = {
      ...prepared.tick,
      action: {
        kind: 'noop',
        reason: `budget_fanout_cap: deferred (${selectedCount}/${totalCandidates} this tick, cap=${cap})`,
      },
    };
    appendEvent(this.config.logPath, deferredTick);
    process.stderr.write(
      `[rr-orchestrator] noop task=${prepared.taskId} reason=${deferredTick.action.reason}\n`,
    );
    return deferredTick;
  }

  private async tickOneTask(
    state: OrchestratorState,
    sessions: RrSession[],
    afk: AfkSnapshot,
    now: number,
  ): Promise<{ state: OrchestratorState; tick: OrchestratorTick | null; prepared: PreparedTaskTick | null }> {
    const prepared = await this.prepareTaskTick(state, sessions, afk, now);
    if (!prepared) return { state, tick: null, prepared: null };

    if (!isFanOutAction(prepared.action)) {
      appendEvent(this.config.logPath, prepared.tick);
      return { state: { ...state, lastTickAt: now }, tick: prepared.tick, prepared: null };
    }

    return { state, tick: null, prepared };
  }

  async tickOnce(): Promise<OrchestratorTick | null> {
    const now = Date.now();
    if (!isOrchestratorEnabled()) return null;
    let state = loadState(this.config.statePath);
    if (state.paused) return null;

    if (!anyActiveAfkWork(this.config)) {
      return null;
    }

    if (this.config.budgetShedder !== false) {
      try {
        const shed = await runBudgetShedderTick({
          pausableAllowlist: this.config.budgetPausableServiceIds,
          maxPausePerTick: this.config.budgetMaxPausePerTick,
          maxResumePerTick: this.config.budgetMaxResumePerTick,
        });
        if (shed.paused.length || shed.resumed.length) {
          state.lastPoolAction = `budget_shed:${shed.pressure_level}:p${shed.paused.length}:r${shed.resumed.length}`;
        }
      } catch {
        // fail-open: shedder errors must not stop AFK ticks
      }
    }

    const sessions = await this.client.listSessions();
    state = await maintainSubagentPool(this.client, this.config, state, sessions, now);

    const fanOutCap = await fetchInjectFanOutCap();
    const taskSnapshots = readActiveTaskSnapshots(this.config);
    let lastTick: OrchestratorTick | null = null;
    const fanOutCandidates: PreparedTaskTick[] = [];

    if (taskSnapshots.length === 0) {
      const afk = readAfkSnapshot(this.config);
      if (afk.paused || afk.done) {
        saveState(this.config.statePath, state);
        return null;
      }
      const legacyResult = await this.tickOneTask(state, sessions, afk, now);
      state = legacyResult.state;
      if (legacyResult.prepared) {
        fanOutCandidates.push(legacyResult.prepared);
      } else {
        lastTick = legacyResult.tick;
      }
    } else {
      for (const afk of taskSnapshots) {
        const result = await this.tickOneTask(state, sessions, afk, now);
        state = result.state;
        if (result.prepared) {
          fanOutCandidates.push(result.prepared);
        } else if (result.tick && (lastTick === null || result.tick.action.kind !== 'noop')) {
          lastTick = result.tick;
        }
      }
    }

    if (fanOutCandidates.length > 0) {
      const ordered = sortFanOutCandidates(fanOutCandidates);
      const selected = ordered.slice(0, fanOutCap);
      const deferred = ordered.slice(fanOutCap);

      for (const prepared of selected) {
        const result = await this.commitTaskTick(state, prepared, now);
        state = result.state;
        if (result.tick.action.kind !== 'noop') {
          lastTick = result.tick;
        }
      }

      for (const prepared of deferred) {
        const deferredTick = this.recordDeferredFanOut(
          prepared,
          fanOutCap,
          selected.length,
          ordered.length,
        );
        if (lastTick === null || lastTick.action.kind === 'noop') {
          lastTick = deferredTick;
        }
      }
    }

    saveState(this.config.statePath, state);
    return lastTick;
  }

  async run(): Promise<void> {
    await this.client.health();
    this.sse = this.client.stream(() => {
      void this.scheduleTick('sse');
    });
    this.pollTimer = setInterval(() => {
      void this.scheduleTick('poll');
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
    await this.scheduleTick('startup');
    while (!this.stopped) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async scheduleTick(source: string): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    const minGapMs = Math.max(250, Math.min(this.config.pollIntervalMs, 1_000));
    const now = Date.now();
    if (source === 'sse' && now - this.lastTickStartedAt < minGapMs) return;
    this.tickInFlight = true;
    this.lastTickStartedAt = now;
    try {
      const tick = await this.tickOnce();
      if (tick && tick.action.kind !== 'noop') {
        const taskLabel = tick.taskId ? ` task=${tick.taskId}` : '';
        process.stderr.write(
          `[rr-orchestrator:${source}] ${tick.action.kind} session=${tick.sessionId}${taskLabel} reason=${'reason' in tick.action ? tick.action.reason : ''}\n`,
        );
      }
    } catch (error) {
      process.stderr.write(`[rr-orchestrator:${source}] error: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      this.tickInFlight = false;
    }
  }
}

export async function orchestratorStatus(config: OrchestratorConfig) {
  const client = new RrHubClient({ hubUrl: config.hubUrl });
  const [health, sessions, state, afk, activeTasks] = await Promise.all([
    client.health(),
    client.listSessions(),
    Promise.resolve(loadState(config.statePath)),
    Promise.resolve(readAfkSnapshot(config)),
    Promise.resolve(readActiveTaskSnapshots(config)),
  ]);
  return { health, sessions, state, afk, activeTasks, config };
}
