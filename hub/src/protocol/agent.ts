import { z } from 'zod';

import { broadcastEventSchema } from './broadcast.js';
import { workflowStageSchema } from './tasks.js';

const isoDateSchema = z.coerce.date();

export const agentCheckpointSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  progress_summary: z.string(),
  context_snapshot: z.unknown(),
  timestamp: isoDateSchema,
});

export const agentCapabilitySchema = z.object({
  agent_id: z.string().min(1),
  roles: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
});

export const agentLoopStatusSchema = z.enum(['working', 'waiting', 'error']);

export const agentLoopStateSchema = z.object({
  iteration: z.number().int().nonnegative(),
  phase: workflowStageSchema,
  status: agentLoopStatusSchema,
});

export const handoffPackageSchema = z.object({
  task_id: z.string().min(1),
  checkpoint: agentCheckpointSchema,
  remaining_steps: z.array(z.string()),
  artifacts: z.array(z.string().min(1)),
});

export const hubCheckpointInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  progress_summary: z.string(),
  context_snapshot: z.unknown(),
  idempotency_key: z.string().min(1).optional(),
});

export const hubCheckpointOutputSchema = z.object({
  checkpoint: agentCheckpointSchema,
});

export const hubHandoffInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
});

export const hubHandoffOutputSchema = z.object({
  package: handoffPackageSchema,
});

export const hubRequestHelpInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  topic: z.string().min(1),
  summary: z.string().min(1),
  payload: z.unknown().optional(),
  correlation_id: z.string().min(1).optional(),
});

export const hubRequestHelpOutputSchema = z.object({
  broadcast: broadcastEventSchema,
});

export const hubReportProgressKindSchema = z.enum(['started', 'progress', 'done', 'error']);

export const hubReportProgressInputSchema = z.object({
  agent_id: z.string().min(1),
  task_id: z.string().min(1),
  kind: hubReportProgressKindSchema,
  pct: z.number().min(0).max(100).optional(),
  message: z.string().optional(),
  details: z.unknown().optional(),
  correlation_id: z.string().min(1).optional(),
});

export const hubReportProgressOutputSchema = z.object({
  recorded: z.boolean(),
  loop: agentLoopStateSchema.optional(),
});

export type HubCheckpointInput = z.infer<typeof hubCheckpointInputSchema>;
export type HubCheckpointOutput = z.infer<typeof hubCheckpointOutputSchema>;
export type HubHandoffInput = z.infer<typeof hubHandoffInputSchema>;
export type HubHandoffOutput = z.infer<typeof hubHandoffOutputSchema>;
export type HubRequestHelpInput = z.infer<typeof hubRequestHelpInputSchema>;
export type HubRequestHelpOutput = z.infer<typeof hubRequestHelpOutputSchema>;
export type HubReportProgressInput = z.infer<typeof hubReportProgressInputSchema>;
export type HubReportProgressOutput = z.infer<typeof hubReportProgressOutputSchema>;
