import { z } from 'zod';

const isoDateSchema = z.coerce.date();

export const planningDocumentSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  version: z.number().int().nonnegative(),
  updated_by: z.string().min(1),
  updated_at: isoDateSchema,
});

export const hubStateReadInputSchema = z.object({
  path: z.string().min(1),
});

export const hubStateReadOutputSchema = z.object({
  document: planningDocumentSchema.nullable(),
});

export const atomicWriteResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('conflict'),
    version: z.number().int().nonnegative(),
  }),
]);

export const hubStateWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  /** Expected current version for optimistic concurrency; use 0 for create-if-missing semantics (hub-defined). */
  expected_version: z.number().int().nonnegative(),
  updated_by: z.string().min(1),
  idempotency_key: z.string().min(1).optional(),
});

export const hubStateWriteOutputSchema = z.object({
  result: atomicWriteResultSchema,
});

export type HubStateReadInput = z.infer<typeof hubStateReadInputSchema>;
export type HubStateReadOutput = z.infer<typeof hubStateReadOutputSchema>;
export type HubStateWriteInput = z.infer<typeof hubStateWriteInputSchema>;
export type HubStateWriteOutput = z.infer<typeof hubStateWriteOutputSchema>;
