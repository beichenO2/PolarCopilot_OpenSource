import { z } from 'zod';

import { workflowStageSchema } from './tasks.js';

export const interventionBehaviorSchema = z.enum(['auto', 'notify', 'block']);

export const interventionMatrixSchema = z.object({
  discuss: interventionBehaviorSchema,
  research: interventionBehaviorSchema,
  compile: interventionBehaviorSchema,
  plan: interventionBehaviorSchema,
  execute: interventionBehaviorSchema,
  verify: interventionBehaviorSchema,
}) satisfies z.ZodType<Record<z.infer<typeof workflowStageSchema>, z.infer<typeof interventionBehaviorSchema>>>;

export const automationPresetSchema = z.enum(['full_auto', 'semi_auto', 'interactive']);

export const hubConfigSchema = z.object({
  version: z.number().int().nonnegative(),
  automation_preset: automationPresetSchema,
  intervention_matrix: interventionMatrixSchema,
  workspace_root: z.string().min(1).optional(),
  default_lease_ttl_ms: z.number().int().positive().optional(),
  default_task_lease_ms: z.number().int().positive().optional(),
});

export const hubGetConfigInputSchema = z.object({
  agent_id: z.string().min(1).optional(),
});

export const hubGetConfigOutputSchema = z.object({
  config: hubConfigSchema,
});

export const hubUpdateConfigInputSchema = z.object({
  agent_id: z.string().min(1),
  expected_version: z.number().int().nonnegative(),
  patch: hubConfigSchema
    .partial()
    .omit({ version: true }),
  idempotency_key: z.string().min(1).optional(),
});

export const hubUpdateConfigOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    config: hubConfigSchema,
  }),
  z.object({
    status: z.literal('conflict'),
    config: hubConfigSchema,
  }),
]);

export type InterventionBehavior = z.infer<typeof interventionBehaviorSchema>;
export type InterventionMatrix = z.infer<typeof interventionMatrixSchema>;
export type AutomationPreset = z.infer<typeof automationPresetSchema>;
export type HubConfig = z.infer<typeof hubConfigSchema>;
export type HubGetConfigInput = z.infer<typeof hubGetConfigInputSchema>;
export type HubGetConfigOutput = z.infer<typeof hubGetConfigOutputSchema>;
export type HubUpdateConfigInput = z.infer<typeof hubUpdateConfigInputSchema>;
export type HubUpdateConfigOutput = z.infer<typeof hubUpdateConfigOutputSchema>;
