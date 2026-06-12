/**
 * Hub MCP tool input/output schemas for the v0.2 question-based workflow.
 *
 * These wrap the core packet schemas from ./packets.ts for use as Hub tool boundaries.
 */

import { z } from 'zod';

import {
  packetEnvelopeSchema,
  questionStateSchema,
  roleSchema,
} from './packets.js';

// ─── hub_submit_question ──────────────────────────────────────────

export const hubSubmitQuestionInputSchema = z.object({
  envelope: packetEnvelopeSchema,
});

export const hubSubmitQuestionOutputSchema = z.object({
  question_id: z.string().min(1),
  state: questionStateSchema,
});

// ─── hub_claim_question ───────────────────────────────────────────

export const hubClaimQuestionInputSchema = z.object({
  role: roleSchema,
  agent_id: z.string().min(1),
  lease_duration_ms: z.number().int().positive().max(86_400_000).default(600_000),
});

export const hubClaimQuestionOutputSchema = z.object({
  envelope: packetEnvelopeSchema.nullable(),
  question_state: questionStateSchema.optional(),
});

// ─── hub_submit_answer ────────────────────────────────────────────

export const hubSubmitAnswerInputSchema = z.object({
  envelope: packetEnvelopeSchema,
});

export const hubSubmitAnswerOutputSchema = z.object({
  question_id: z.string().min(1),
  state: questionStateSchema,
});

// ─── hub_submit_escalation ────────────────────────────────────────

export const hubSubmitEscalationInputSchema = z.object({
  envelope: packetEnvelopeSchema,
});

export const hubSubmitEscalationOutputSchema = z.object({
  question_id: z.string().min(1),
  state: questionStateSchema,
  escalated_to: roleSchema,
});

// ─── hub_resolve_escalation ───────────────────────────────────────

export const hubResolveEscalationInputSchema = z.object({
  escalation_id: z.string().min(1),
  original_question_id: z.string().min(1),
  agent_id: z.string().min(1),
  action: z.enum(['revise', 'cancel']),
  revised_envelope: packetEnvelopeSchema.optional(),
});

export const hubResolveEscalationOutputSchema = z.object({
  original_question_id: z.string().min(1),
  original_state: questionStateSchema,
  new_question_id: z.string().optional(),
});

// ─── hub_get_context_ref ──────────────────────────────────────────

export const hubGetContextRefInputSchema = z.object({
  context_ref: z.string().min(1),
  agent_id: z.string().min(1),
});

export const hubGetContextRefOutputSchema = z.object({
  ref: z.string().min(1),
  content: z.string().optional(),
  found: z.boolean(),
});

// ─── Type exports ─────────────────────────────────────────────────

export type HubSubmitQuestionInput = z.infer<typeof hubSubmitQuestionInputSchema>;
export type HubSubmitQuestionOutput = z.infer<typeof hubSubmitQuestionOutputSchema>;
export type HubClaimQuestionInput = z.infer<typeof hubClaimQuestionInputSchema>;
export type HubClaimQuestionOutput = z.infer<typeof hubClaimQuestionOutputSchema>;
export type HubSubmitAnswerInput = z.infer<typeof hubSubmitAnswerInputSchema>;
export type HubSubmitAnswerOutput = z.infer<typeof hubSubmitAnswerOutputSchema>;
export type HubSubmitEscalationInput = z.infer<typeof hubSubmitEscalationInputSchema>;
export type HubSubmitEscalationOutput = z.infer<typeof hubSubmitEscalationOutputSchema>;
export type HubResolveEscalationInput = z.infer<typeof hubResolveEscalationInputSchema>;
export type HubResolveEscalationOutput = z.infer<typeof hubResolveEscalationOutputSchema>;
export type HubGetContextRefInput = z.infer<typeof hubGetContextRefInputSchema>;
export type HubGetContextRefOutput = z.infer<typeof hubGetContextRefOutputSchema>;
