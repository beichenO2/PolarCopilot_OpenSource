/**
 * PolarCopilot Hub — standalone server (Agent Control + YOLO).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pino from 'pino';
import { BroadcastPublisher } from './broadcast/publisher.js';
import { SseHub } from './broadcast/sse-hub.js';
import { EventSubscriber } from './broadcast/subscriber.js';
import { createHubDatabase } from './persistence/db.js';
import { HubStore } from './persistence/store.js';
import { createHubExpress, createStandaloneApp } from './transport/standalone.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));

const dbPath = process.env.PC_HUB_DB ?? join(process.cwd(), '.data/hub.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });

const { db } = createHubDatabase(dbPath);
const store = new HubStore(db);
const sseHub = new SseHub();
const eventSubscriber = new EventSubscriber();
const publisher = new BroadcastPublisher(store, sseHub, eventSubscriber);

const app = createHubExpress();
createStandaloneApp(app, {
  hubDb: db,
  ctx: { logger, hubStartedAt: new Date() },
  publisher,
  store,
});

const portFilePath = join(dirname(dbPath), 'last-port');
let savedPort: number | undefined;
try { savedPort = Number(readFileSync(portFilePath, 'utf-8').trim()); } catch { /* none */ }

const port = Number(process.env.PC_HUB_PORT ?? process.env.PORT ?? savedPort ?? 8040);
const host = process.env.PC_HUB_HOST ?? '127.0.0.1';

const httpServer = app.listen(port, host, () => {
  logger.info({ port, host, dbPath }, 'PolarCopilot Hub listening');
  try { writeFileSync(portFilePath, String(port), 'utf-8'); } catch { /* non-fatal */ }
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  logger.fatal({ err: err.message, port }, 'failed to bind');
  process.exit(1);
});
