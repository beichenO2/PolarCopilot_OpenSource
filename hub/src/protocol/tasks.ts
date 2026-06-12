import { z } from 'zod';

const isoDateSchema = z.coerce.date();

export const taskStatusSchema = z.enum(['open', 'claimed', 'done', 'blocked', 'cancelled']);

export const workflowStageSchema = z.enum(['discuss', 'research', 'compile', 'plan', 'execute', 'verify']);

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(''),
  status: taskStatusSchema,
  owner_agent_id: z.string().min(1).nullable(),
  parent_task_id: z.string().min(1).nullable(),
  depends_on: z.array(z.string().min(1)),
  workflow_stage: workflowStageSchema,
  priority: z.number().int(),
  module: z.string().nullable().default(null),
  created_at: isoDateSchema,
  updated_at: isoDateSchema,
  lease_expires_at: isoDateSchema.nullable(),
});

export const hubCreateTaskInputSchema = z.object({
  creator_agent_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  workflow_stage: workflowStageSchema,
  priority: z.number().int().default(0),
  depends_on: z.array(z.string().min(1)).optional(),
  parent_task_id: z.string().min(1).nullable().optional(),
  module: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const hubCreateTaskOutputSchema = z.object({
  task: taskSchema,
});

export const hubClaimTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  lease_duration_ms: z.number().int().positive().max(86_400_000).default(600_000),
  heartbeat_interval_ms: z.number().int().positive().max(3_600_000).default(60_000),
  workflow_stage: workflowStageSchema.optional(),
});

export const schedulingHintSchema = z.object({
  reason: z.string(),
  preferred_agent: z.string(),
  your_tokens: z.number(),
  preferred_tokens: z.number(),
}).optional();

export const hubClaimTaskOutputSchema = z.object({
  task: taskSchema.nullable(),
  scheduling_hint: schedulingHintSchema,
});

export const hubHeartbeatTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  lease_extend_ms: z.number().int().positive().max(86_400_000).optional(),
});

export const hubHeartbeatTaskOutputSchema = z.object({
  task: taskSchema,
});

export const hubCompleteTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  result_summary: z.string().optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const hubCompleteTaskOutputSchema = z.object({
  task: taskSchema,
});

export const hubListTasksInputSchema = z.object({
  status: taskStatusSchema.optional(),
  workflow_stage: workflowStageSchema.optional(),
  owner_agent_id: z.string().min(1).optional(),
  ready_only: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const hubListTasksOutputSchema = z.object({
  tasks: z.array(taskSchema),
});

export const hubSplitTaskChildSpecSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  workflow_stage: workflowStageSchema.optional(),
  priority: z.number().int().optional(),
});

export const hubSplitTaskInputSchema = z.object({
  agent_id: z.string().min(1),
  parent_task_id: z.string().min(1),
  children: z.array(hubSplitTaskChildSpecSchema).min(1),
  idempotency_key: z.string().min(1).optional(),
});

export const hubSplitTaskOutputSchema = z.object({
  parent: taskSchema,
  children: z.array(taskSchema),
});

export type HubCreateTaskInput = z.infer<typeof hubCreateTaskInputSchema>;
export type HubCreateTaskOutput = z.infer<typeof hubCreateTaskOutputSchema>;
export type HubClaimTaskInput = z.infer<typeof hubClaimTaskInputSchema>;
export type HubClaimTaskOutput = z.infer<typeof hubClaimTaskOutputSchema>;
export type HubHeartbeatTaskInput = z.infer<typeof hubHeartbeatTaskInputSchema>;
export type HubHeartbeatTaskOutput = z.infer<typeof hubHeartbeatTaskOutputSchema>;
export type HubCompleteTaskInput = z.infer<typeof hubCompleteTaskInputSchema>;
export type HubCompleteTaskOutput = z.infer<typeof hubCompleteTaskOutputSchema>;
export type HubListTasksInput = z.infer<typeof hubListTasksInputSchema>;
export type HubListTasksOutput = z.infer<typeof hubListTasksOutputSchema>;
export type HubSplitTaskInput = z.infer<typeof hubSplitTaskInputSchema>;
export type HubSplitTaskOutput = z.infer<typeof hubSplitTaskOutputSchema>;
