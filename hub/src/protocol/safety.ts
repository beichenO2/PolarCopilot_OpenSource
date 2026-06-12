import { z } from 'zod';

import { workflowStageSchema } from './tasks.js';

const isoDateSchema = z.coerce.date();

export const safetyLimitsSchema = z.object({
  max_tool_calls: z.number().int().positive(),
  max_tokens: z.number().int().positive(),
  max_wall_time_ms: z.number().int().positive(),
});

export const auditEntrySchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().min(1),
  task_id: z.string().min(1).nullable(),
  action: z.string().min(1),
  details: z.unknown(),
  timestamp: isoDateSchema,
  correlation_id: z.string().min(1).nullable(),
});

export const healthStatusSchema = z.object({
  stale_agents: z.array(z.string().min(1)),
  queue_depth: z.number().int().nonnegative(),
  active_tasks: z.number().int().nonnegative(),
  anomalies: z.array(z.string().min(1)),
});

export const progressAggregateSchema = z.object({
  phase: workflowStageSchema,
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  active_agents: z.number().int().nonnegative(),
});

export const hubSetLimitsInputSchema = z.object({
  agent_id: z.string().min(1),
  limits: safetyLimitsSchema,
  expected_version: z.number().int().nonnegative().optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const hubSetLimitsOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    limits: safetyLimitsSchema,
    config_version: z.number().int().nonnegative().optional(),
  }),
  z.object({
    status: z.literal('conflict'),
    limits: safetyLimitsSchema,
    config_version: z.number().int().nonnegative().optional(),
  }),
]);

export const hubGetAuditLogInputSchema = z.object({
  after_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  agent_id: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
});

export const hubGetAuditLogOutputSchema = z.object({
  entries: z.array(auditEntrySchema),
  cursor: z.string().min(1).optional(),
});

export const hubGetHealthInputSchema = z.object({
  agent_id: z.string().min(1).optional(),
});

export const hubGetHealthOutputSchema = z.object({
  health: healthStatusSchema,
});

export const hubGetProgressInputSchema = z.object({
  workflow_stage: workflowStageSchema.optional(),
});

export const hubGetProgressOutputSchema = z.object({
  by_phase: z.array(progressAggregateSchema),
});

export type HubSetLimitsInput = z.infer<typeof hubSetLimitsInputSchema>;
export type HubSetLimitsOutput = z.infer<typeof hubSetLimitsOutputSchema>;
export type HubGetAuditLogInput = z.infer<typeof hubGetAuditLogInputSchema>;
export type HubGetAuditLogOutput = z.infer<typeof hubGetAuditLogOutputSchema>;
export type HubGetHealthInput = z.infer<typeof hubGetHealthInputSchema>;
export type HubGetHealthOutput = z.infer<typeof hubGetHealthOutputSchema>;
export type HubGetProgressInput = z.infer<typeof hubGetProgressInputSchema>;
export type HubGetProgressOutput = z.infer<typeof hubGetProgressOutputSchema>;
