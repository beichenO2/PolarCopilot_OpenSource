import { readAfkSnapshot } from './afk-state.js';
import { isOrchestratorEnabled } from './toggle.js';
import { RrHubClient } from './hub-client.js';
import { contentHash, planNextAction } from './planner.js';
import { appendEvent, bumpInjection, loadState, saveState } from './state.js';
import type { OrchestratorConfig, OrchestratorTick, PlannerAction } from './types.js';
import type { RrSession } from '../types.js';

function pickMasterSession(sessions: RrSession[], config: OrchestratorConfig): RrSession | null {
  const masters = sessions.filter((session) => !session.isSubagent);
  if (config.masterSessionId) {
    return masters.find((session) => session.sessionId === config.masterSessionId) ?? null;
  }
  if (config.masterSessionName) {
    return masters.find((session) => session.name === config.masterSessionName) ?? null;
  }
  return masters
    .slice()
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0] ?? null;
}

function emitLoopSentinel(config: OrchestratorConfig, tick: OrchestratorTick): void {
  if (!config.loopBridge) return;
  const payload = JSON.stringify({
    sessionId: tick.sessionId,
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
    case 'wake':
      await client.injectMessage(sessionId, action.content);
      break;
    case 'dispatch':
      await client.dispatchTask(sessionId, action.targetSessionId, action.content);
      break;
    default:
      break;
  }
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

  async tickOnce(): Promise<OrchestratorTick | null> {
    const now = Date.now();
    if (!isOrchestratorEnabled()) return null;
    let state = loadState(this.config.statePath);
    if (state.paused) return null;

    const afk = readAfkSnapshot(this.config);
    if (afk.paused || afk.done) {
      state.paused = true;
      state.lastAction = afk.done ? 'done' : 'pause';
      saveState(this.config.statePath, state);
      return null;
    }

    const sessions = await this.client.listSessions();
    const master = pickMasterSession(sessions, this.config);
    if (!master) return null;

    const detail = await this.client.sessionDetail(master.sessionId);
    const subagents = await this.client.listSubagents(master.sessionId);
    const action = planNextAction({
      config: this.config,
      state,
      afk,
      session: detail.session,
      history: detail.history,
      subagents,
    }, now);

    const tick: OrchestratorTick = { at: now, sessionId: master.sessionId, action };
    state.lastTickAt = now;
    state.lastSessionId = master.sessionId;
    state.lastAction = action.kind;
    appendEvent(this.config.logPath, tick);

    if (action.kind === 'inject' || action.kind === 'wake' || action.kind === 'dispatch') {
      await executeAction(this.client, this.config, master.sessionId, action);
      if (action.kind === 'inject' || action.kind === 'wake') {
        state.lastInjectedHash = 'content' in action ? contentHash(action.content) : state.lastInjectedHash;
      }
      state = bumpInjection(state, now, this.config.maxInjectionsPerHour);
      emitLoopSentinel(this.config, tick);
    }

    saveState(this.config.statePath, state);
    return tick;
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
    // SSE can burst dozens of events in <1s; debounce to poll cadence.
    const minGapMs = Math.max(250, Math.min(this.config.pollIntervalMs, 1_000));
    const now = Date.now();
    if (source === 'sse' && now - this.lastTickStartedAt < minGapMs) return;
    this.tickInFlight = true;
    this.lastTickStartedAt = now;
    try {
      const tick = await this.tickOnce();
      if (tick && tick.action.kind !== 'noop') {
        process.stderr.write(`[rr-orchestrator:${source}] ${tick.action.kind} session=${tick.sessionId} reason=${'reason' in tick.action ? tick.action.reason : ''}\n`);
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
  const [health, sessions, state, afk] = await Promise.all([
    client.health(),
    client.listSessions(),
    Promise.resolve(loadState(config.statePath)),
    Promise.resolve(readAfkSnapshot(config)),
  ]);
  return { health, sessions, state, afk, config };
}
