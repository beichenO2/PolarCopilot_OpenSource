/**
 * PolarCopilot Packet Exchange Protocol v0.2
 *
 * Canonical Zod schemas for QuestionPacket, AnswerPacket, EscalationPacket
 * and the PacketEnvelope transport layer.
 *
 * Design doc: .planning/PACKET-CONTRACT.md
 */

import { z } from 'zod';

// ─── §2.1 Role enum ────────────────────────────────────────────────

export const roleSchema = z.enum([
  'proxy',
  'controller',
  'worker',
  'supervisor',
  'clk',
  'standby',
  // v0.3 hybrid cooperation model
  'orchestrator',
  'domain_worker',
]);

export type Role = z.infer<typeof roleSchema>;

// ─── §2.2 Question type enum ──────────────────────────────────────

export const questionTypeSchema = z.enum([
  'phase_objective',
  'decomposition_task',
  'implementation_task',
  'review_task',
  'verification_task',
]);

export type QuestionType = z.infer<typeof questionTypeSchema>;

// ─── §2.3 Question state machine ──────────────────────────────────

export const questionStateSchema = z.enum([
  'queued',
  'claimed',
  'in_progress',
  'answered',
  'escalated',
  'timed_out',
  'cancelled',
]);

export type QuestionState = z.infer<typeof questionStateSchema>;

// ─── §2.4 Timestamp (RFC 3339) ────────────────────────────────────

export const timestampSchema = z.string().datetime();

// ─── §3 PacketEnvelope ─────────────────────────────────────────────

export const packetTypeSchema = z.enum([
  'question',
  'answer',
  'escalation',
]);

export type PacketType = z.infer<typeof packetTypeSchema>;

export const packetEnvelopeSchema = z.object({
  packet_id: z.string().min(1),
  packet_type: packetTypeSchema,
  packet_version: z.literal('1.0'),

  correlation_id: z.string().min(1),
  causation_id: z.string().min(1).optional(),

  idempotency_key: z.string().min(1),
  attempt: z.number().int().positive().default(1),

  emitted_at: timestampSchema,

  payload: z.unknown(),
});

export type PacketEnvelope = z.infer<typeof packetEnvelopeSchema>;

// ─── §4 QuestionPacket ─────────────────────────────────────────────

export const scopeSchema = z.object({
  files_to_read: z.array(z.string()).default([]),
  files_to_write: z.array(z.string()).default([]),
  directories: z.array(z.string()).default([]),
});

export type Scope = z.infer<typeof scopeSchema>;

export const contextBundleSchema = z.object({
  project_summary: z.string().max(500),
  phase_summary: z.string().max(300),
  tech_stack: z.string().max(200).optional(),
  important_dirs: z.record(z.string(), z.string()).optional(),
  recent_history: z.array(z.string().max(200)).max(10).default([]),
  non_goals: z.array(z.string().max(200)).default([]),
});

export type ContextBundle = z.infer<typeof contextBundleSchema>;

export const acceptanceItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(300),
  type: z.enum(['command', 'assertion', 'artifact', 'review']),
  command: z.string().max(500).optional(),
  expected: z.string().max(300).optional(),
  required: z.boolean().default(true),
});

export type AcceptanceItem = z.infer<typeof acceptanceItemSchema>;

export const outputFormatSchema = z.enum([
  'answer_packet',
  'escalation_packet',
]);

export const outputContractSchema = z.object({
  must_include: z.array(z.string().min(1)).min(1),
  allowed_formats: z.array(outputFormatSchema).min(1),
});

export type OutputContract = z.infer<typeof outputContractSchema>;

export const escalationRuleSchema = z.object({
  allowed: z.boolean().default(true),
  max_escalations: z.number().int().positive().default(1),
  escalate_to: roleSchema.default('controller'),
});

export type EscalationRule = z.infer<typeof escalationRuleSchema>;

export const questionPacketSchema = z.object({
  question_id: z.string().min(1),
  question_type: questionTypeSchema,
  phase_id: z.string().min(1).optional(),
  parent_question_id: z.string().min(1).optional(),

  from_role: roleSchema,
  from_agent_id: z.string().min(1),
  to_role: roleSchema,

  objective: z.string().min(1).max(500),
  reason: z.string().min(1).max(300),
  scope: scopeSchema,
  constraints: z.array(z.string().max(300)).default([]),
  acceptance: z.array(acceptanceItemSchema).min(1),

  context: contextBundleSchema,
  context_refs: z.array(z.string()).default([]),

  output_contract: outputContractSchema,
  escalation_rule: escalationRuleSchema.optional(),

  depends_on_questions: z.array(z.string()).default([]),
  depends_on_tasks: z.array(z.string()).default([]),

  created_at: timestampSchema,
  deadline_at: timestampSchema.optional(),
  priority: z.number().int().default(0),
});

export type QuestionPacket = z.infer<typeof questionPacketSchema>;

// ─── §5 AnswerPacket (discriminated union) ─────────────────────────

export const answerStatusSchema = z.enum([
  'completed',
  'partial',
  'failed',
]);

export type AnswerStatus = z.infer<typeof answerStatusSchema>;

export const acceptanceItemResultSchema = z.object({
  acceptance_id: z.string().min(1),
  passed: z.boolean(),
  evidence: z.array(z.string().max(500)).min(1),
});

export type AcceptanceItemResult = z.infer<typeof acceptanceItemResultSchema>;

export const acceptanceResultSchema = z.object({
  passed: z.boolean(),
  items: z.array(acceptanceItemResultSchema).default([]),
  commands_run: z.array(z.string()).default([]),
});

export type AcceptanceResult = z.infer<typeof acceptanceResultSchema>;

export const answerPacketBaseSchema = z.object({
  question_id: z.string().min(1),
  answer_id: z.string().min(1),

  from_role: roleSchema,
  from_agent_id: z.string().min(1),
  to_role: roleSchema,

  status: answerStatusSchema,
  summary: z.string().min(1).max(1000),

  blockers: z.array(z.string().max(300)).default([]),

  acceptance_result: acceptanceResultSchema.optional(),

  created_at: timestampSchema,
  execution_time_ms: z.number().int().nonnegative().optional(),
});

// §5.2 implementation_result (Worker → Controller)
export const implementationAnswerPacketSchema = answerPacketBaseSchema.extend({
  answer_type: z.literal('implementation_result'),
  changed_files: z.array(z.string()).default([]),
  commands_run: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
});

export type ImplementationAnswerPacket = z.infer<typeof implementationAnswerPacketSchema>;

// §5.3 decomposition_result (Controller → Proxy)
export const decompositionAnswerPacketSchema = answerPacketBaseSchema.extend({
  answer_type: z.literal('decomposition_result'),

  decomposition_summary: z.object({
    total_questions: z.number().int().nonnegative(),
    notes: z.array(z.string().max(300)).default([]),
  }),

  submitted_question_ids: z.array(z.string()).default([]),
});

export type DecompositionAnswerPacket = z.infer<typeof decompositionAnswerPacketSchema>;

// §5.4 review_result (Supervisor → Controller)
export const reviewAnswerPacketSchema = answerPacketBaseSchema.extend({
  answer_type: z.literal('review_result'),
  review: z.object({
    verdict: z.enum(['pass', 'revise', 'reject']),
    findings: z.array(z.string().max(500)).default([]),
    required_fixes: z.array(z.string().max(300)).default([]),
    risk_level: z.enum(['low', 'medium', 'high']).default('low'),
  }),
});

export type ReviewAnswerPacket = z.infer<typeof reviewAnswerPacketSchema>;

// §5.5 verification_result (Supervisor → Controller)
export const verificationAnswerPacketSchema = answerPacketBaseSchema.extend({
  answer_type: z.literal('verification_result'),
  verification: z.object({
    verdict: z.enum(['pass', 'revise', 'reject']),
    findings: z.array(z.string().max(500)).default([]),
    missing_acceptance_ids: z.array(z.string()).default([]),
    risk_level: z.enum(['low', 'medium', 'high']).default('low'),
  }),
});

export type VerificationAnswerPacket = z.infer<typeof verificationAnswerPacketSchema>;

// §5.6 Union
export const answerPacketSchema = z.discriminatedUnion('answer_type', [
  implementationAnswerPacketSchema,
  decompositionAnswerPacketSchema,
  reviewAnswerPacketSchema,
  verificationAnswerPacketSchema,
]);

export type AnswerPacket = z.infer<typeof answerPacketSchema>;

// ─── §6 EscalationPacket ──────────────────────────────────────────

export const blockerTypeSchema = z.enum([
  'missing_constraint',
  'missing_context',
  'dependency_blocked',
  'technical_conflict',
  'scope_exceeded',
  'permission_needed',
  'quality_degradation',
]);

export type BlockerType = z.infer<typeof blockerTypeSchema>;

export const proposedOptionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(500),
  trade_offs: z.string().max(300).optional(),
  recommended: z.boolean().default(false),
});

export type ProposedOption = z.infer<typeof proposedOptionSchema>;

export const escalationPacketSchema = z.object({
  question_id: z.string().min(1),
  escalation_id: z.string().min(1),

  from_role: roleSchema,
  from_agent_id: z.string().min(1),
  escalate_to: roleSchema,

  blocker_type: blockerTypeSchema,
  blocker_summary: z.string().min(1).max(500),
  impact: z.string().min(1).max(300),

  partial_work: z.object({
    changed_files: z.array(z.string()).default([]),
    summary: z.string().max(500).optional(),
  }).optional(),

  proposed_options: z.array(proposedOptionSchema).min(1),

  default_option_id: z.string().min(1).optional(),

  created_at: timestampSchema,
}).superRefine((data, ctx) => {
  if (data.default_option_id) {
    const exists = data.proposed_options.some(opt => opt.id === data.default_option_id);
    if (!exists) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'default_option_id must reference proposed_options[].id',
        path: ['default_option_id'],
      });
    }
  }
});

export type EscalationPacket = z.infer<typeof escalationPacketSchema>;

// ─── §11 Protocol invariant helpers ───────────────────────────────

/**
 * Validate AnswerPacket business invariants beyond schema:
 * - completed → must have acceptance_result
 * - blockers non-empty → status ≠ completed
 */
export function validateAnswerInvariants(
  packet: AnswerPacket,
): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = [];

  if (packet.status === 'completed' && !packet.acceptance_result) {
    violations.push('status=completed requires acceptance_result');
  }

  if (packet.blockers.length > 0 && packet.status === 'completed') {
    violations.push('blockers non-empty but status=completed');
  }

  return violations.length === 0
    ? { ok: true }
    : { ok: false, violations };
}

/**
 * Wrap a business payload in a PacketEnvelope.
 * Caller must supply packet_id, correlation_id, idempotency_key.
 */
export function wrapEnvelope(
  payload: QuestionPacket | AnswerPacket | EscalationPacket,
  meta: {
    packet_id: string;
    packet_type: PacketType;
    correlation_id: string;
    causation_id?: string;
    idempotency_key: string;
    attempt?: number;
  },
): PacketEnvelope {
  return {
    packet_id: meta.packet_id,
    packet_type: meta.packet_type,
    packet_version: '1.0',
    correlation_id: meta.correlation_id,
    causation_id: meta.causation_id,
    idempotency_key: meta.idempotency_key,
    attempt: meta.attempt ?? 1,
    emitted_at: new Date().toISOString(),
    payload,
  };
}
