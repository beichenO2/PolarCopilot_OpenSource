import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { evolutionSignals, evolutionGenes, evolutionSuggestions, evolutionEvents, EVOLUTION_DDL } from '../evolution/schema.js';

export const sessions = sqliteTable('sessions', {
  mcpSessionId: text('mcp_session_id').primaryKey(),
  agentId: text('agent_id').notNull().unique(),
  label: text('label'),
  displayName: text('display_name'),
  agentType: text('agent_type'),
  parentAgentId: text('parent_agent_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  lastPingAt: integer('last_ping_at', { mode: 'timestamp_ms' }),
  // Agent 注册扩展字段
  mainModel: text('main_model'),
  subagentModel: text('subagent_model'),
  agentStatus: text('agent_status').default('active'),
  lastHeartbeat: integer('last_heartbeat', { mode: 'timestamp_ms' }),
  currentPromptId: text('current_prompt_id'),
  blockedSince: integer('blocked_since', { mode: 'timestamp_ms' }),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
});

/** Monotonic broadcast/event log (Phase 2). */
export const events = sqliteTable('events', {
  sequenceNumber: integer('sequence_number').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  sourceAgentId: text('source_agent_id').notNull(),
  topic: text('topic').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const eventCursors = sqliteTable('event_cursors', {
  agentId: text('agent_id').primaryKey(),
  lastSeenSequence: integer('last_seen_sequence').notNull().default(0),
});

export const planningDocuments = sqliteTable('planning_documents', {
  path: text('path').primaryKey(),
  content: text('content').notNull(),
  version: integer('version').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const idempotencyKeys = sqliteTable('idempotency_keys', {
  key: text('key').primaryKey(),
  result: text('result').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  status: text('status').notNull(),
  ownerAgentId: text('owner_agent_id'),
  parentTaskId: text('parent_task_id'),
  workflowStage: text('workflow_stage').notNull(),
  priority: integer('priority').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  module: text('module'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
});

export const taskDependencies = sqliteTable(
  'task_dependencies',
  {
    taskId: text('task_id').notNull(),
    dependsOnTaskId: text('depends_on_task_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
  }),
);

export const pathLeases = sqliteTable('path_leases', {
  leaseId: text('lease_id').primaryKey(),
  path: text('path').notNull().unique(),
  agentId: text('agent_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const agentCapabilities = sqliteTable('agent_capabilities', {
  agentId: text('agent_id').primaryKey(),
  rolesJson: text('roles').notNull(),
  skillsJson: text('skills').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  taskId: text('task_id'),
  action: text('action').notNull(),
  details: text('details').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  correlationId: text('correlation_id'),
});

export const agentSafetyLimits = sqliteTable('agent_safety_limits', {
  agentId: text('agent_id').primaryKey(),
  maxToolCalls: integer('max_tool_calls').notNull(),
  maxTokens: integer('max_tokens').notNull(),
  maxWallTimeMs: integer('max_wall_time_ms').notNull(),
  version: integer('version').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const moduleAffinity = sqliteTable(
  'module_affinity',
  {
    agentId: text('agent_id').notNull(),
    module: text('module').notNull(),
    source: text('source').notNull(),
    completedCount: integer('completed_count').notNull().default(0),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.module] }),
  }),
);

export const agentRoles = sqliteTable('agent_roles', {
  agentId: text('agent_id').primaryKey(),
  role: text('role').notNull(),
  status: text('status').notNull().default('active'),
  tmuxSession: text('tmux_session'),
  assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }).notNull(),
  lastHeartbeat: integer('last_heartbeat', { mode: 'timestamp_ms' }),
  stateSnapshot: text('state_snapshot'),
  predecessorId: text('predecessor_id'),
});

export const reservePool = sqliteTable('reserve_pool', {
  agentId: text('agent_id').primaryKey(),
  tmuxSession: text('tmux_session').notNull(),
  status: text('status').notNull().default('standby'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  assignedAt: integer('assigned_at', { mode: 'timestamp_ms' }),
});

export const questions = sqliteTable('questions', {
  questionId: text('question_id').primaryKey(),
  questionType: text('question_type').notNull(),
  phaseId: text('phase_id'),
  parentQuestionId: text('parent_question_id'),
  fromRole: text('from_role').notNull(),
  fromAgentId: text('from_agent_id').notNull(),
  toRole: text('to_role').notNull(),
  state: text('state').notNull().default('queued'),
  ownerAgentId: text('owner_agent_id'),
  payload: text('payload').notNull(),
  correlationId: text('correlation_id'),
  envelopeJson: text('envelope_json').notNull(),
  answerJson: text('answer_json'),
  escalationJson: text('escalation_json'),
  priority: integer('priority').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  deadlineAt: integer('deadline_at', { mode: 'timestamp_ms' }),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
});

export const questionDependencies = sqliteTable(
  'question_dependencies',
  {
    questionId: text('question_id').notNull(),
    dependsOnQuestionId: text('depends_on_question_id').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.questionId, t.dependsOnQuestionId] }),
  }),
);

export const uiPrompts = sqliteTable('ui_prompts', {
  id: text('id').primaryKey(),
  prompt: text('prompt').notNull(),
  optionsJson: text('options_json').notNull(),
  answer: text('answer'),
  agentId: text('agent_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  answeredAt: integer('answered_at', { mode: 'timestamp_ms' }),
});

export const clkState = sqliteTable('clk_state', {
  id: integer('id').primaryKey().default(1),
  tickNumber: integer('tick_number').notNull().default(0),
  lastTickAt: integer('last_tick_at', { mode: 'timestamp_ms' }),
  tickIntervalMs: integer('tick_interval_ms').notNull().default(30000),
});

export const sotadiffEntries = sqliteTable('sotadiff_entries', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  gitCommit: text('git_commit'),
  intent: text('intent').notNull(),
  filesJson: text('files_json').notNull(),
  summary: text('summary').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const pilotProjects = sqliteTable('pilot_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('draft'),
  inputSpec: text('input_spec').notNull().default(''),
  outputSpec: text('output_spec').notNull().default(''),
  phasesJson: text('phases_json').notNull().default('[]'),
  assignedAgents: text('assigned_agents').notNull().default('[]'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const p22Alerts = sqliteTable('p22_alerts', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  gitCommit: text('git_commit'),
  alertType: text('alert_type').notNull(),
  filePath: text('file_path').notNull(),
  otherAgentId: text('other_agent_id'),
  details: text('details').notNull(),
  acknowledged: integer('acknowledged', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const prolusionPlans = sqliteTable('prolusion_plans', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  goal: text('goal').notNull(),
  status: text('status').notNull().default('stage_1'),
  currentStage: integer('current_stage').notNull().default(1),
  demandAnalysis: text('demand_analysis').notNull().default('{}'),
  codeMapping: text('code_mapping').notNull().default('{}'),
  techOverview: text('tech_overview').notNull().default('{}'),
  taskAllocation: text('task_allocation').notNull().default('[]'),
  ssotRefs: text('ssot_refs').notNull().default('[]'),
  createdBy: text('created_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const projectOwnership = sqliteTable('project_ownership', {
  projectName: text('project_name').primaryKey(),
  agentId: text('agent_id').notNull(),
  projectPath: text('project_path').notNull().default(''),
  registeredAt: integer('registered_at', { mode: 'timestamp_ms' }).notNull(),
});

export const alignmentDocs = sqliteTable('alignment_docs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull(),
  status: text('status').notNull().default('draft'),
  goal: text('goal').notNull().default(''),
  workLogic: text('work_logic').notNull().default('Debug > Test > Dev'),
  workflowsJson: text('workflows_json').notNull().default('[]'),
  planMarkdown: text('plan_markdown').notNull().default(''),
  sectionsJson: text('sections_json').notNull().default('[]'),
  version: integer('version').notNull().default(1),
  pilotProjectId: text('pilot_project_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  approvedAt: integer('approved_at', { mode: 'timestamp_ms' }),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
});

export const alignmentVersions = sqliteTable('alignment_versions', {
  id: text('id').primaryKey(),
  alignmentId: text('alignment_id').notNull(),
  version: integer('version').notNull(),
  planMarkdown: text('plan_markdown').notNull(),
  sectionsJson: text('sections_json').notNull(),
  changedBy: text('changed_by').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

const hubSchema = {
  sessions,
  messages,
  events,
  eventCursors,
  planningDocuments,
  idempotencyKeys,
  tasks,
  taskDependencies,
  pathLeases,
  agentCapabilities,
  auditLog,
  agentSafetyLimits,
  moduleAffinity,
  agentRoles,
  reservePool,
  clkState,
  questions,
  questionDependencies,
  uiPrompts,
  sotadiffEntries,
  pilotProjects,
  p22Alerts,
  prolusionPlans,
  projectOwnership,
  alignmentDocs,
  alignmentVersions,
  evolutionSignals,
  evolutionGenes,
  evolutionSuggestions,
  evolutionEvents,
};

export type HubDb = BetterSQLite3Database<typeof hubSchema>;
export type HubSqlite = Database.Database;

/** Open SQLite with WAL + crash-safety-oriented pragmas, apply schema if missing. */
export function createHubDatabase(dbPath: string): { sqlite: HubSqlite; db: HubDb } {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('cache_size = -8000');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      mcp_session_id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL UNIQUE,
      label text,
      display_name text,
      agent_type text,
      parent_agent_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      last_ping_at integer
    );
    CREATE TABLE IF NOT EXISTS messages (
      id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      payload text NOT NULL,
      created_at integer NOT NULL,
      consumed_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_messages_agent_pending ON messages (agent_id) WHERE consumed_at IS NULL;
    CREATE TABLE IF NOT EXISTS events (
      sequence_number integer PRIMARY KEY AUTOINCREMENT,
      id text NOT NULL UNIQUE,
      source_agent_id text NOT NULL,
      topic text NOT NULL,
      payload text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_cursors (
      agent_id text PRIMARY KEY NOT NULL,
      last_seen_sequence integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS planning_documents (
      path text PRIMARY KEY NOT NULL,
      content text NOT NULL,
      version integer NOT NULL,
      updated_by text NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key text PRIMARY KEY NOT NULL,
      result text NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);
    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY NOT NULL,
      status text NOT NULL,
      owner_agent_id text,
      parent_task_id text,
      workflow_stage text NOT NULL,
      priority integer NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      module text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      lease_expires_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_open_claim ON tasks (status, priority, created_at);
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id text NOT NULL,
      depends_on_task_id text NOT NULL,
      PRIMARY KEY (task_id, depends_on_task_id)
    );
    CREATE TABLE IF NOT EXISTS path_leases (
      lease_id text PRIMARY KEY NOT NULL,
      path text NOT NULL UNIQUE,
      agent_id text NOT NULL,
      created_at integer NOT NULL,
      expires_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_path_leases_expires ON path_leases (expires_at);
    CREATE TABLE IF NOT EXISTS agent_capabilities (
      agent_id text PRIMARY KEY NOT NULL,
      roles text NOT NULL,
      skills text NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      task_id text,
      action text NOT NULL,
      details text NOT NULL,
      created_at integer NOT NULL,
      correlation_id text
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at);
    CREATE TABLE IF NOT EXISTS agent_safety_limits (
      agent_id text PRIMARY KEY NOT NULL,
      max_tool_calls integer NOT NULL,
      max_tokens integer NOT NULL,
      max_wall_time_ms integer NOT NULL,
      version integer NOT NULL DEFAULT 0,
      updated_at integer NOT NULL
    );
    CREATE TABLE IF NOT EXISTS module_affinity (
      agent_id text NOT NULL,
      module text NOT NULL,
      source text NOT NULL,
      completed_count integer NOT NULL DEFAULT 0,
      updated_at integer NOT NULL,
      PRIMARY KEY (agent_id, module)
    );
    CREATE INDEX IF NOT EXISTS idx_module_affinity_module ON module_affinity (module);
    CREATE TABLE IF NOT EXISTS agent_roles (
      agent_id text PRIMARY KEY NOT NULL,
      role text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      tmux_session text,
      assigned_at integer NOT NULL,
      last_heartbeat integer,
      state_snapshot text,
      predecessor_id text
    );
    CREATE INDEX IF NOT EXISTS idx_agent_roles_role ON agent_roles (role);
    CREATE TABLE IF NOT EXISTS reserve_pool (
      agent_id text PRIMARY KEY NOT NULL,
      tmux_session text NOT NULL,
      status text NOT NULL DEFAULT 'standby',
      created_at integer NOT NULL,
      assigned_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_reserve_pool_status ON reserve_pool (status);
    CREATE TABLE IF NOT EXISTS clk_state (
      id integer PRIMARY KEY DEFAULT 1,
      tick_number integer NOT NULL DEFAULT 0,
      last_tick_at integer,
      tick_interval_ms integer NOT NULL DEFAULT 30000
    );
    INSERT OR IGNORE INTO clk_state (id, tick_number, tick_interval_ms) VALUES (1, 0, 30000);
    CREATE TABLE IF NOT EXISTS questions (
      question_id text PRIMARY KEY NOT NULL,
      question_type text NOT NULL,
      phase_id text,
      parent_question_id text,
      from_role text NOT NULL,
      from_agent_id text NOT NULL,
      to_role text NOT NULL,
      state text NOT NULL DEFAULT 'queued',
      owner_agent_id text,
      payload text NOT NULL,
      correlation_id text,
      envelope_json text NOT NULL,
      answer_json text,
      escalation_json text,
      priority integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      deadline_at integer,
      lease_expires_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_questions_state_priority ON questions (state, priority, created_at);
    CREATE INDEX IF NOT EXISTS idx_questions_to_role ON questions (to_role, state);
    CREATE INDEX IF NOT EXISTS idx_questions_correlation ON questions (correlation_id);
    CREATE TABLE IF NOT EXISTS question_dependencies (
      question_id text NOT NULL,
      depends_on_question_id text NOT NULL,
      PRIMARY KEY (question_id, depends_on_question_id)
    );
    CREATE TABLE IF NOT EXISTS ui_prompts (
      id text PRIMARY KEY NOT NULL,
      prompt text NOT NULL,
      options_json text NOT NULL,
      answer text,
      agent_id text,
      created_at integer NOT NULL,
      answered_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_ui_prompts_pending ON ui_prompts (answered_at) WHERE answered_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_events_topic_seq ON events (topic, sequence_number);
    CREATE INDEX IF NOT EXISTS idx_ui_prompts_agent_pending ON ui_prompts (agent_id) WHERE answered_at IS NULL;
    CREATE TABLE IF NOT EXISTS sotadiff_entries (
      id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      git_commit text,
      intent text NOT NULL,
      files_json text NOT NULL,
      summary text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sotadiff_created ON sotadiff_entries (created_at);
    CREATE INDEX IF NOT EXISTS idx_sotadiff_agent ON sotadiff_entries (agent_id, created_at);
    CREATE TABLE IF NOT EXISTS pilot_projects (
      id text PRIMARY KEY NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      input_spec text NOT NULL DEFAULT '',
      output_spec text NOT NULL DEFAULT '',
      phases_json text NOT NULL DEFAULT '[]',
      assigned_agents text NOT NULL DEFAULT '[]',
      created_by text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      started_at integer,
      completed_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_pilot_status ON pilot_projects (status);
    CREATE TABLE IF NOT EXISTS alignment_docs (
      id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      status text NOT NULL DEFAULT 'draft',
      goal text NOT NULL DEFAULT '',
      work_logic text NOT NULL DEFAULT 'Debug > Test > Dev',
      workflows_json text NOT NULL DEFAULT '[]',
      plan_markdown text NOT NULL DEFAULT '',
      sections_json text NOT NULL DEFAULT '[]',
      version integer NOT NULL DEFAULT 1,
      pilot_project_id text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      approved_at integer,
      completed_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_alignment_status ON alignment_docs (status);
    CREATE INDEX IF NOT EXISTS idx_alignment_agent ON alignment_docs (agent_id);
    CREATE TABLE IF NOT EXISTS alignment_versions (
      id text PRIMARY KEY NOT NULL,
      alignment_id text NOT NULL,
      version integer NOT NULL,
      plan_markdown text NOT NULL,
      sections_json text NOT NULL,
      changed_by text NOT NULL,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alignment_versions_doc ON alignment_versions (alignment_id, version);
    CREATE TABLE IF NOT EXISTS p22_alerts (
      id text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      git_commit text,
      alert_type text NOT NULL,
      file_path text NOT NULL,
      other_agent_id text,
      details text NOT NULL,
      acknowledged integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_p22_alerts_agent ON p22_alerts (agent_id, acknowledged);
    CREATE TABLE IF NOT EXISTS prolusion_plans (
      id text PRIMARY KEY NOT NULL,
      title text NOT NULL,
      goal text NOT NULL,
      status text NOT NULL DEFAULT 'stage_1',
      current_stage integer NOT NULL DEFAULT 1,
      demand_analysis text NOT NULL DEFAULT '{}',
      code_mapping text NOT NULL DEFAULT '{}',
      tech_overview text NOT NULL DEFAULT '{}',
      task_allocation text NOT NULL DEFAULT '[]',
      ssot_refs text NOT NULL DEFAULT '[]',
      created_by text,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      completed_at integer
    );
    CREATE INDEX IF NOT EXISTS idx_prolusion_status ON prolusion_plans (status);
    CREATE TABLE IF NOT EXISTS project_ownership (
      project_name text PRIMARY KEY NOT NULL,
      agent_id text NOT NULL,
      project_path text NOT NULL DEFAULT '',
      registered_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_ownership_agent ON project_ownership (agent_id);
  `);

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ssot_annotations (
      id text PRIMARY KEY NOT NULL,
      project text NOT NULL,
      field_path text NOT NULL,
      author text NOT NULL,
      author_type text NOT NULL DEFAULT 'user',
      text text NOT NULL,
      parent_id text,
      created_at integer NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ssot_ann_project ON ssot_annotations (project);
  `);

  sqlite.exec(EVOLUTION_DDL);

  // migrations for new columns
  const addColIfMissing = (table: string, col: string, type: string) => {
    try { sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch (_) { /* already exists */ }
  };
  addColIfMissing('sessions', 'display_name', 'text');
  addColIfMissing('sessions', 'agent_type', 'text');
  addColIfMissing('sessions', 'parent_agent_id', 'text');
  // Agent 注册扩展字段迁移
  addColIfMissing('sessions', 'main_model', 'text');
  addColIfMissing('sessions', 'subagent_model', 'text');
  addColIfMissing('sessions', 'agent_status', 'text');
  addColIfMissing('sessions', 'last_heartbeat', 'integer');
  addColIfMissing('sessions', 'current_prompt_id', 'text');
  addColIfMissing('sessions', 'blocked_since', 'integer');

  const db = drizzle(sqlite, { schema: hubSchema });
  return { sqlite, db };
}
