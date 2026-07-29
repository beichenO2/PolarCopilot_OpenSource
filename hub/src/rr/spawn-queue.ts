import { randomUUID } from 'node:crypto';
import type pino from 'pino';
import { spawnCursorAgent, stopCursorAgentForSession, type SpawnCursorAgentResult } from './cursor-spawn.js';
import { sweepOrphanCursorAgents } from './cursor-agent-orphans.js';
import type { RrFileStore } from './store.js';
import type { RrSession } from './types.js';

export type SpawnQueueJobStatus = 'pending' | 'spawning' | 'waiting_online' | 'done' | 'failed';

export interface SpawnQueueJob {
  jobId: string;
  sessionId: string;
  label: string;
  status: SpawnQueueJobStatus;
  waitUntilOnline: boolean;
  pid?: number;
  workspace?: string;
  online?: boolean;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SpawnQueueBatch {
  batchId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  jobs: SpawnQueueJob[];
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueSpawnInput {
  session: RrSession;
  workspace?: string;
  headless?: boolean;
  waitUntilOnline?: boolean;
  label?: string;
}

export interface CursorSpawnQueueOptions {
  gapMs?: number;
  waitOnlineTimeoutMs?: number;
  pollMs?: number;
  offlineAfterMs?: number;
  logger?: pino.Logger;
  onUpdate?: (batch: SpawnQueueBatch | null, job: SpawnQueueJob | null) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CursorSpawnQueue {
  private readonly gapMs: number;
  private readonly waitOnlineTimeoutMs: number;
  private readonly pollMs: number;
  private readonly offlineAfterMs: number;
  private readonly logger?: pino.Logger;
  private readonly onUpdate?: CursorSpawnQueueOptions['onUpdate'];

  private chain: Promise<void> = Promise.resolve();
  private pendingCount = 0;
  private activeJob: SpawnQueueJob | null = null;
  private readonly batches = new Map<string, SpawnQueueBatch>();
  private lastBatchId: string | null = null;
  private readonly cancelledSessionIds = new Set<string>();

  constructor(private readonly store: RrFileStore, options: CursorSpawnQueueOptions = {}) {
    this.gapMs = options.gapMs ?? Number(process.env.RR_SPAWN_GAP_MS ?? 5_000);
    this.waitOnlineTimeoutMs = options.waitOnlineTimeoutMs ?? Number(process.env.RR_SPAWN_WAIT_ONLINE_MS ?? 90_000);
    this.pollMs = options.pollMs ?? 1_500;
    this.offlineAfterMs = options.offlineAfterMs ?? Number(process.env.RR_OFFLINE_MS ?? 90_000);
    this.logger = options.logger;
    this.onUpdate = options.onUpdate;
    void this.sweepOrphans('init');
  }

  async sweepOrphans(reason: string): Promise<void> {
    try {
      const result = await sweepOrphanCursorAgents(this.store.listTrackedCursorAgentPids());
      if (result.killed.length > 0) {
        this.logger?.warn({ reason, killed: result.killed }, 'rr cursor-agent orphan sweep');
      }
    } catch (error) {
      this.logger?.warn({ reason, error: error instanceof Error ? error.message : String(error) }, 'rr cursor-agent orphan sweep failed');
    }
  }

  getStatus() {
    return {
      running: this.activeJob !== null || this.pendingCount > 0,
      pendingCount: this.pendingCount,
      activeJob: this.activeJob,
      activeBatchId: this.findActiveBatchId(),
      gapMs: this.gapMs,
      waitOnlineTimeoutMs: this.waitOnlineTimeoutMs,
    };
  }

  getBatch(batchId: string): SpawnQueueBatch | undefined {
    return this.batches.get(batchId);
  }

  getLatestBatch(): SpawnQueueBatch | null {
    if (!this.lastBatchId) return null;
    return this.batches.get(this.lastBatchId) ?? null;
  }

  cancelJobsForSession(sessionId: string): number {
    this.cancelledSessionIds.add(sessionId);
    let cancelled = 0;
    for (const batch of this.batches.values()) {
      for (const job of batch.jobs) {
        if (job.sessionId !== sessionId || job.status !== 'pending') continue;
        job.status = 'failed';
        job.error = 'session_deleted';
        job.finishedAt = Date.now();
        cancelled += 1;
      }
      this.touchBatch(batch);
    }
    return cancelled;
  }

  createBatch(): SpawnQueueBatch {
    const batch: SpawnQueueBatch = {
      batchId: randomUUID(),
      status: 'queued',
      jobs: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.batches.set(batch.batchId, batch);
    this.lastBatchId = batch.batchId;
    if (this.batches.size > 10) {
      const oldest = [...this.batches.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) this.batches.delete(oldest[0]);
    }
    return batch;
  }

  enqueue(input: EnqueueSpawnInput, batchId?: string): Promise<SpawnCursorAgentResult> {
    const job: SpawnQueueJob = {
      jobId: randomUUID(),
      sessionId: input.session.sessionId,
      label: input.label ?? input.session.name,
      status: 'pending',
      waitUntilOnline: input.waitUntilOnline ?? false,
    };

    const batch = batchId ? this.batches.get(batchId) : undefined;
    if (batch) {
      batch.jobs.push(job);
      batch.updatedAt = Date.now();
      this.emit(batch, job);
    }

    this.pendingCount += 1;

    return new Promise((resolve, reject) => {
      this.chain = this.chain.then(async () => {
        try {
          resolve(await this.runJob(input, job, batch));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private findActiveBatchId(): string | null {
    for (const batch of this.batches.values()) {
      if (batch.status === 'running' || batch.status === 'queued') return batch.batchId;
    }
    return null;
  }

  private emit(batch: SpawnQueueBatch | null, job: SpawnQueueJob | null) {
    this.onUpdate?.(batch, job);
  }

  private touchBatch(batch: SpawnQueueBatch | undefined) {
    if (!batch) return;
    batch.updatedAt = Date.now();
    const allSettled = batch.jobs.every((entry) => entry.status === 'done' || entry.status === 'failed');
    if (!allSettled) return;
    batch.status = batch.jobs.some((entry) => entry.status === 'failed') ? 'failed' : 'completed';
    this.emit(batch, null);
  }

  private sessionReady(sessionId: string): boolean {
    const session = this.store.getSession(sessionId);
    const online = Date.now() - session.lastActiveAt <= this.offlineAfterMs;
    // Hub pre-register marks sessions online before CLI connects; require wait_message heartbeat.
    return online && session.waiting;
  }

  private async waitForOnline(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + this.waitOnlineTimeoutMs;
    while (Date.now() < deadline) {
      if (this.sessionReady(sessionId)) return true;
      await sleep(this.pollMs);
    }
    return false;
  }

  private async runJob(
    input: EnqueueSpawnInput,
    job: SpawnQueueJob,
    batch: SpawnQueueBatch | undefined,
  ): Promise<SpawnCursorAgentResult> {
    this.activeJob = job;
    if (batch && batch.status === 'queued') {
      batch.status = 'running';
      batch.updatedAt = Date.now();
    }
    this.emit(batch ?? null, job);

    try {
      if (this.cancelledSessionIds.has(input.session.sessionId) || !this.store.sessionExists(input.session.sessionId)) {
        job.status = 'failed';
        job.error = 'session_deleted';
        job.finishedAt = Date.now();
        this.emit(batch ?? null, job);
        throw new Error('session_deleted');
      }

      job.status = 'spawning';
      job.startedAt = Date.now();
      this.emit(batch ?? null, job);

      this.store.killCursorAgentForSession(input.session.sessionId);

      if (this.cancelledSessionIds.has(input.session.sessionId) || !this.store.sessionExists(input.session.sessionId)) {
        job.status = 'failed';
        job.error = 'session_deleted';
        job.finishedAt = Date.now();
        this.emit(batch ?? null, job);
        throw new Error('session_deleted');
      }

      const spawnResult = await spawnCursorAgent({
        session: input.session,
        workspace: input.workspace,
        headless: input.headless,
        dataRoot: this.store.root,
      });

      if (this.cancelledSessionIds.has(input.session.sessionId) || !this.store.sessionExists(input.session.sessionId)) {
        await stopCursorAgentForSession({
          sessionId: input.session.sessionId,
          cursorAgentPid: spawnResult.pid,
          polarProcessServiceId: spawnResult.polarProcessServiceId,
        });
        job.status = 'failed';
        job.error = 'session_deleted';
        job.finishedAt = Date.now();
        this.emit(batch ?? null, job);
        throw new Error('session_deleted');
      }

      job.pid = spawnResult.pid;
      job.workspace = spawnResult.workspace;
      this.store.setCursorAgentManaged(input.session.sessionId, {
        pid: spawnResult.pid,
        polarProcessServiceId: spawnResult.polarProcessServiceId,
      });
      this.logger?.info({
        sessionId: input.session.sessionId,
        pid: spawnResult.pid,
        label: job.label,
        queued: true,
      }, 'rr spawn-cursor (queued)');

      if (input.waitUntilOnline) {
        job.status = 'waiting_online';
        this.emit(batch ?? null, job);
        job.online = await this.waitForOnline(input.session.sessionId);
        if (!job.online) {
          this.logger?.warn({ sessionId: input.session.sessionId, label: job.label }, 'rr spawn online wait timed out');
        }
      }

      job.status = 'done';
      job.finishedAt = Date.now();
      this.emit(batch ?? null, job);
      return spawnResult;
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.finishedAt = Date.now();
      this.emit(batch ?? null, job);
      throw error;
    } finally {
      this.activeJob = null;
      this.pendingCount = Math.max(0, this.pendingCount - 1);
      this.touchBatch(batch);
      if (this.gapMs > 0) await sleep(this.gapMs);
    }
  }
}
