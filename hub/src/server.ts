import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { BroadcastPublisher } from './broadcast/publisher.js';
import { SseHub } from './broadcast/sse-hub.js';
import { EventSubscriber } from './broadcast/subscriber.js';
import { watchConfig } from './config/loader.js';
import { LifecycleTracker } from './lifecycle/tracker.js';
import { createHubDatabase, sessions, agentRoles } from './persistence/db.js';
import { eq } from 'drizzle-orm';
import { PathLeaseService } from './persistence/path-leases.js';
import { AuditJournal } from './safety/audit.js';
import { SafetyLimiter } from './safety/limiter.js';
import { HubStore } from './persistence/store.js';
import { SessionRegistry } from './session/registry.js';
import { ModuleAffinityService } from './tasks/affinity.js';
import { ProgressTracker } from './tasks/progress.js';
import { TaskService } from './tasks/service.js';
import { QuestionService } from './questions/service.js';
import { createHubExpress, mountStreamableHttpHub } from './transport/http.js';
import { createEvolutionRouter } from './evolution/routes.js';
import { createCheckupRouter } from './checkup/route.js';
import { createLobsterRouter } from './lobster/router.js';
import { createAlertsRouter } from './alerts/router.js';
import { createToolsRouter } from './tools/router.js';
import { createXjRouter } from './xj/router.js';
import { defaultXjSkillRoot, XjSkillRouter } from './xj/skill-router.js';
import { XjFileStore } from './xj/store.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));
const hubStartedAt = new Date();

const dbPath = process.env.PC_HUB_DB ?? join(process.cwd(), '.planning/hub/hub.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });

const { sqlite, db } = createHubDatabase(dbPath);
const store = new HubStore(db);
const registry = new SessionRegistry(store, logger);
const sseHub = new SseHub();
const eventSubscriber = new EventSubscriber();
const publisher = new BroadcastPublisher(store, sseHub, eventSubscriber);
const taskService = new TaskService(db, sqlite, store);
const questionService = new QuestionService(db, sqlite, store);
const pathLeaseService = new PathLeaseService(db);
const progressTracker = new ProgressTracker();
const safetyLimiter = new SafetyLimiter(db);
const moduleAffinityService = new ModuleAffinityService(db, safetyLimiter);
taskService.setLimiter(safetyLimiter);
taskService.setAffinityService(moduleAffinityService);
const auditJournal = new AuditJournal(db);
const lifecycleTracker = new LifecycleTracker(publisher, logger);
const xjDataRoot = process.env.PC_XJ_DATA_ROOT ?? join(homedir(), '.polarcopilot', 'xj');
const xjStore = new XjFileStore(xjDataRoot, { staleAfterMs: 24 * 60 * 60 * 1000 });
const xjSkillRouter = new XjSkillRouter(defaultXjSkillRoot());

const stopConfigWatch = watchConfig(process.cwd(), (cfg) => {
  logger.info({ version: cfg.version }, 'config.json reloaded');
});

const app = createHubExpress();
app.use('/api/evolution', createEvolutionRouter(db));
app.use('/api', createCheckupRouter({ db, publisher, logger, sseHub }));
app.use('/api', createLobsterRouter({ publisher, logger }));
app.use('/api', createAlertsRouter({ sseHub }));
app.use('/api', createToolsRouter({ sseHub }));
mountStreamableHttpHub(app, {
  store,
  registry,
  ctx: { logger, hubStartedAt },
  sseHub,
  publisher,
  eventSubscriber,
  mirrorRoot: process.cwd(),
  taskService,
  pathLeaseService,
  progressTracker,
  safetyLimiter,
  auditJournal,
  hubDb: db,
  moduleAffinityService,
  lifecycleTracker,
  questionService,
});
// Mount after the shared /api/ui middleware so XJ inherits host validation,
// rate limiting, and the standard UI response headers.
app.use('/api', createXjRouter({ store: xjStore, skillRouter: xjSkillRouter, logger }));

const portFilePath = join(dirname(dbPath), 'last-port');
let savedPort: number | undefined;
try { savedPort = Number(readFileSync(portFilePath, 'utf-8').trim()); } catch { /* no saved port */ }
const preferred = Number(process.env.PC_HUB_PORT ?? process.env.PORT ?? savedPort ?? 8040);
const host = process.env.PC_HUB_HOST ?? '127.0.0.1';

const { createRequire } = await import('node:module');
const _require = createRequire(import.meta.url);
const portSdkPath = process.env.PORT_SDK_PATH
  ?? join(process.env.HOME ?? '', 'Polarisor', 'PolarPort', 'src', 'sdk', 'index.cjs');
const { claimPort, registerCapabilities } = _require(portSdkPath) as {
  claimPort: (o: { service: string; project: string; preferred?: number }) => Promise<number>;
  registerCapabilities: (source: string) => Promise<void>;
};

async function findExistingHub(): Promise<number | null> {
  try {
    const resp = await fetch('http://127.0.0.1:11050/api/list');
    if (!resp.ok) return null;
    const ports = (await resp.json()) as Array<{
      port: number;
      project: string;
      service_name?: string;
      status?: string;
    }>;
    const candidates = ports.filter((p) =>
      p.project === 'PolarCopilot'
      && p.service_name === 'polarcop-hub'
      && p.status === 'active');
    for (const c of candidates) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const r = await fetch(`http://127.0.0.1:${c.port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'self-check', version: '1.0' } },
            id: 0,
          }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        const txt = await r.text();
        if (txt.includes('polarcop-hub')) {
          return c.port;
        }
      } catch { /* port not responding as Hub */ }
    }
  } catch { /* port-sdk not available */ }
  return null;
}

const existingPort = await findExistingHub();
if (existingPort) {
  logger.error({ existingPort }, 'Another PolarCopilot Hub is already running. Exiting to avoid port drift.');
  process.exit(1);
}

let port: number;
try {
  port = await claimPort({ service: 'polarcop-hub', project: 'PolarCopilot', preferred });
} catch (e: unknown) {
  logger.fatal({ err: e instanceof Error ? e.message : String(e) }, 'PolarPort claimPort failed; refusing to start');
  process.exit(1);
}

const capPath = join(dirname(new URL(import.meta.url).pathname), '..', 'capabilities.json');
registerCapabilities(capPath).catch((e: unknown) => logger.warn({ err: e }, 'capability registration failed (non-fatal)'));

const httpServer = app.listen(port, host, () => {
  logger.info({ port, host, dbPath }, 'PolarCopilot Hub (Streamable HTTP) listening');
  try { writeFileSync(portFilePath, String(port), 'utf-8'); } catch { /* non-fatal */ }
  lifecycleTracker.start();
});

import { ALIVE_THRESHOLD_MS, WEEKLY_GC_THRESHOLD_MS, STARTUP_GRACE_MS, GC_INTERVAL_MS } from './constants.js';

// Orphan-slave detach: runs frequently (every ALIVE_THRESHOLD_MS) but only detaches
// parent references — never deletes sessions. Safe to run immediately after restart.
const orphanDetachTimer = setInterval(() => {
  const now = Date.now();
  const allRows = db.select().from(sessions).all();

  const aliveIds = new Set(
    allRows
      .filter((s) => s.lastPingAt && now - new Date(s.lastPingAt).getTime() < ALIVE_THRESHOLD_MS)
      .map((s) => s.agentId),
  );

  let detachedCount = 0;
  for (const s of allRows) {
    if (s.parentAgentId && !aliveIds.has(s.parentAgentId) && aliveIds.has(s.agentId)) {
      db.update(sessions)
        .set({ parentAgentId: null, updatedAt: new Date() })
        .where(eq(sessions.agentId, s.agentId))
        .run();
      detachedCount++;
    }
  }
  if (detachedCount > 0) {
    logger.info({ detached: detachedCount }, 'auto-detached orphan slaves');
  }
}, ALIVE_THRESHOLD_MS);

// Weekly GC: runs daily at midnight, purges all ephemeral data older than 7 days.
// Skips the first cycle after startup (grace period) so agents that were alive
// before a Hub restart have time to re-register.
let gcGraceExpired = false;
setTimeout(() => { gcGraceExpired = true; }, STARTUP_GRACE_MS);

const slidingWindowGcTimer = setInterval(() => {
  if (!gcGraceExpired) {
    logger.info('weekly GC: skipped (startup grace period)');
    return;
  }

  const stats = store.slidingWindowGC(WEEKLY_GC_THRESHOLD_MS);
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  if (total > 0) {
    logger.info({ stats, windowDays: WEEKLY_GC_THRESHOLD_MS / 86_400_000 }, 'weekly GC completed');
  }
}, GC_INTERVAL_MS);

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down hub');
  clearInterval(orphanDetachTimer);
  clearInterval(slidingWindowGcTimer);
  lifecycleTracker.stop();
  stopConfigWatch();
  httpServer.close(() => {
    sqlite.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
