import { z } from 'zod';

const isoDateSchema = z.coerce.date();

export const hubPublishInputSchema = z.object({
  agent_id: z.string().min(1),
  topic: z.string().min(1),
  payload: z.unknown(),
  idempotency_key: z.string().min(1).optional(),
  correlation_id: z.string().min(1).optional(),
});

export const broadcastEventSchema = z.object({
  id: z.string().min(1),
  agent_id: z.string().min(1),
  topic: z.string().min(1),
  payload: z.unknown(),
  timestamp: isoDateSchema,
});

export const hubPublishOutputSchema = z.object({
  event: broadcastEventSchema,
  deduplicated: z.boolean().optional(),
});

export const hubSubscribeInputSchema = z.object({
  agent_id: z.string().min(1),
  topics: z.array(z.string()).default([]),
});

export const eventSubscriptionSchema = z.object({
  agent_id: z.string().min(1),
  topics: z.array(z.string()),
});

export const hubSubscribeOutputSchema = z.object({
  subscription: eventSubscriptionSchema,
});

export const hubPollEventsInputSchema = z.object({
  agent_id: z.string().min(1),
  /** Exclusive lower bound; omit or empty to read from start / hub default cursor. */
  after_event_id: z.string().min(1).optional(),
  limit: z.number().int().positive().max(500).optional(),
  /** When true, return events without advancing the cursor (events can be re-read). */
  peek: z.boolean().optional(),
});

export const hubPollEventsOutputSchema = z.object({
  events: z.array(broadcastEventSchema),
  /** Client should pass this as `after_event_id` on the next poll when supported. */
  cursor: z.string().min(1).optional(),
});

export type HubPublishInput = z.infer<typeof hubPublishInputSchema>;
export type HubPublishOutput = z.infer<typeof hubPublishOutputSchema>;
export type HubSubscribeInput = z.infer<typeof hubSubscribeInputSchema>;
export type HubSubscribeOutput = z.infer<typeof hubSubscribeOutputSchema>;
export type HubPollEventsInput = z.infer<typeof hubPollEventsInputSchema>;
export type HubPollEventsOutput = z.infer<typeof hubPollEventsOutputSchema>;
