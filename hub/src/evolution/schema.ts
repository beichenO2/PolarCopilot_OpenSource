import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const evolutionSignals = sqliteTable('evolution_signals', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  source: text('source').notNull(),
  agentId: text('agent_id'),
  title: text('title').notNull(),
  details: text('details').notNull(),
  contextJson: text('context_json').notNull().default('{}'),
  processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const evolutionGenes = sqliteTable('evolution_genes', {
  id: text('id').primaryKey(),
  category: text('category').notNull(),
  title: text('title').notNull(),
  signalsMatchJson: text('signals_match_json').notNull(),
  strategyJson: text('strategy_json').notNull(),
  validationJson: text('validation_json').notNull().default('[]'),
  constraintsJson: text('constraints_json').notNull().default('{}'),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const evolutionSuggestions = sqliteTable('evolution_suggestions', {
  id: text('id').primaryKey(),
  geneId: text('gene_id').notNull(),
  signalIdsJson: text('signal_ids_json').notNull(),
  status: text('status').notNull().default('pending'),
  title: text('title').notNull(),
  analysis: text('analysis').notNull(),
  proposedChange: text('proposed_change').notNull(),
  blastRadiusJson: text('blast_radius_json').notNull().default('{"files":0,"lines":0}'),
  agentId: text('agent_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  resolvedBy: text('resolved_by'),
  rejectReason: text('reject_reason'),
});

export const evolutionEvents = sqliteTable('evolution_events', {
  id: text('id').primaryKey(),
  suggestionId: text('suggestion_id').notNull(),
  geneId: text('gene_id').notNull(),
  intent: text('intent').notNull(),
  signalsUsedJson: text('signals_used_json').notNull(),
  blastRadiusJson: text('blast_radius_json').notNull(),
  gitCommit: text('git_commit'),
  outcome: text('outcome').notNull(),
  summary: text('summary').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const EVOLUTION_DDL = `
  CREATE TABLE IF NOT EXISTS evolution_signals (
    id text PRIMARY KEY NOT NULL,
    type text NOT NULL,
    source text NOT NULL,
    agent_id text,
    title text NOT NULL,
    details text NOT NULL,
    context_json text NOT NULL DEFAULT '{}',
    processed_at integer,
    created_at integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evo_signals_type ON evolution_signals (type, created_at);
  CREATE INDEX IF NOT EXISTS idx_evo_signals_unprocessed ON evolution_signals (processed_at) WHERE processed_at IS NULL;

  CREATE TABLE IF NOT EXISTS evolution_genes (
    id text PRIMARY KEY NOT NULL,
    category text NOT NULL,
    title text NOT NULL,
    signals_match_json text NOT NULL,
    strategy_json text NOT NULL,
    validation_json text NOT NULL DEFAULT '[]',
    constraints_json text NOT NULL DEFAULT '{}',
    success_count integer NOT NULL DEFAULT 0,
    failure_count integer NOT NULL DEFAULT 0,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
  );

  CREATE TABLE IF NOT EXISTS evolution_suggestions (
    id text PRIMARY KEY NOT NULL,
    gene_id text NOT NULL,
    signal_ids_json text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    title text NOT NULL,
    analysis text NOT NULL,
    proposed_change text NOT NULL,
    blast_radius_json text NOT NULL DEFAULT '{"files":0,"lines":0}',
    agent_id text,
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    resolved_at integer,
    resolved_by text,
    reject_reason text
  );
  CREATE INDEX IF NOT EXISTS idx_evo_suggestions_status ON evolution_suggestions (status, created_at);

  CREATE TABLE IF NOT EXISTS evolution_events (
    id text PRIMARY KEY NOT NULL,
    suggestion_id text NOT NULL,
    gene_id text NOT NULL,
    intent text NOT NULL,
    signals_used_json text NOT NULL,
    blast_radius_json text NOT NULL,
    git_commit text,
    outcome text NOT NULL,
    summary text NOT NULL,
    created_at integer NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_evo_events_created ON evolution_events (created_at);
`;
