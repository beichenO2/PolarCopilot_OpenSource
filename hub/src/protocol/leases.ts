import { z } from 'zod';

const isoDateSchema = z.coerce.date();

export const pathLeaseSchema = z.object({
  path: z.string().min(1),
  agent_id: z.string().min(1),
  lease_id: z.string().min(1),
  expires_at: isoDateSchema,
  created_at: isoDateSchema,
});

export const hubAcquireLeaseInputSchema = z.object({
  agent_id: z.string().min(1),
  path: z.string().min(1),
  ttl_ms: z.number().int().positive().max(86_400_000).optional(),
  idempotency_key: z.string().min(1).optional(),
});

export const hubAcquireLeaseOutputSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('granted'),
    lease: pathLeaseSchema,
  }),
  z.object({
    status: z.literal('conflict'),
    holder: pathLeaseSchema,
  }),
]);

export const hubReleaseLeaseInputSchema = z.object({
  agent_id: z.string().min(1),
  lease_id: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
}).refine((v) => v.lease_id != null || v.path != null, {
  message: 'lease_id or path required',
});

export const hubReleaseLeaseOutputSchema = z.object({
  released: z.boolean(),
});

export const hubCheckLeaseInputSchema = z.object({
  path: z.string().min(1),
});

export const hubCheckLeaseOutputSchema = z.object({
  lease: pathLeaseSchema.nullable(),
});

export type HubAcquireLeaseInput = z.infer<typeof hubAcquireLeaseInputSchema>;
export type HubAcquireLeaseOutput = z.infer<typeof hubAcquireLeaseOutputSchema>;
export type HubReleaseLeaseInput = z.infer<typeof hubReleaseLeaseInputSchema>;
export type HubReleaseLeaseOutput = z.infer<typeof hubReleaseLeaseOutputSchema>;
export type HubCheckLeaseInput = z.infer<typeof hubCheckLeaseInputSchema>;
export type HubCheckLeaseOutput = z.infer<typeof hubCheckLeaseOutputSchema>;
