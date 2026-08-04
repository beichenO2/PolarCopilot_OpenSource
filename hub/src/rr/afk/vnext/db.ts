import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL DEFAULT '',
  project_root TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('ide', 'web')),
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'solo' CHECK (mode IN ('start', 'solo')),
  priority INTEGER NOT NULL DEFAULT 0,
  last_scheduled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  executor_kind TEXT NOT NULL CHECK (executor_kind IN ('cursor-native', 'cursor-cli')),
  native_handle TEXT,
  conversation_id TEXT,
  pid INTEGER,
  service_id TEXT,
  heartbeat_at TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'owner' CHECK (status IN ('owner', 'superseded', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_one_owner
  ON runs(task_id) WHERE status = 'owner';

CREATE INDEX IF NOT EXISTS idx_runs_conversation
  ON runs(conversation_id) WHERE conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_units (
  unit_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  parent_id TEXT,
  state TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'implementer',
  lane_key TEXT NOT NULL DEFAULT 'main',
  allowed_writes TEXT NOT NULL DEFAULT '[]',
  verify_cmd TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expiry TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_units_task ON work_units(task_id);

CREATE TABLE IF NOT EXISTS criteria (
  criterion_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  text TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  evidence_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_criteria_task ON criteria(task_id);

CREATE TABLE IF NOT EXISTS evidence (
  evidence_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  salient TEXT NOT NULL DEFAULT '',
  timestamp TEXT NOT NULL,
  artifact_digest TEXT,
  producer_role TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_bindings (
  binding_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  lane_key TEXT NOT NULL,
  role TEXT NOT NULL,
  native_subagent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bindings_task ON agent_bindings(task_id);
`;

export function defaultAfkDbPath(): string {
  const override = process.env.POLAR_AFK_DB;
  if (override) return override;
  return join(homedir(), '.polar-copilot', 'afk', 'afk.db');
}

export type AfkDb = Database.Database;

let singleton: AfkDb | null = null;
let singletonPath: string | null = null;

export function openAfkDb(dbPath = defaultAfkDbPath()): AfkDb {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  }
  return db;
}

/** Process singleton — tests should prefer openAfkDb(tempPath) and close. */
export function getAfkDb(): AfkDb {
  const path = defaultAfkDbPath();
  if (!singleton || singletonPath !== path) {
    if (singleton) singleton.close();
    singleton = openAfkDb(path);
    singletonPath = path;
  }
  return singleton;
}

export function closeAfkDb(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
    singletonPath = null;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
