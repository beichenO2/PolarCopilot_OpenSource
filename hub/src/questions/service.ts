/**
 * QuestionService — persistence layer for the v0.2 packet exchange protocol.
 *
 * Manages the Question lifecycle state machine (§7 of PACKET-CONTRACT.md):
 *   queued → claimed → in_progress → answered | escalated | timed_out
 *                                    → cancelled (from any non-terminal)
 */

import { and, eq, lte } from 'drizzle-orm';
import type { HubSqlite } from '../persistence/db.js';
import { questions, questionDependencies, type HubDb } from '../persistence/db.js';
import type { HubStore } from '../persistence/store.js';
import {
  questionPacketSchema,
  answerPacketSchema,
  escalationPacketSchema,
  validateAnswerInvariants,
  type PacketEnvelope,
  type QuestionState,
} from '../protocol/packets.js';
import type {
  HubSubmitQuestionOutput,
  HubClaimQuestionOutput,
  HubSubmitAnswerOutput,
  HubSubmitEscalationOutput,
  HubResolveEscalationOutput,
} from '../protocol/questions.js';

const IDEMPOTENCY_TTL_MS = 86_400_000;

export class QuestionService {
  constructor(
    private readonly db: HubDb,
    private readonly sqlite: HubSqlite,
    private readonly store: HubStore,
  ) {}

  submitQuestion(envelope: PacketEnvelope): HubSubmitQuestionOutput {
    const idempKey = envelope.idempotency_key;
    if (idempKey) {
      const cached = this.store.getIdempotencyResult(idempKey) as HubSubmitQuestionOutput | null;
      if (cached && typeof cached === 'object' && 'question_id' in cached) {
        return cached;
      }
    }

    if (envelope.packet_type !== 'question') {
      throw new Error('envelope_type_mismatch: expected question');
    }

    const question = questionPacketSchema.parse(envelope.payload);
    const now = new Date();

    for (const depId of question.depends_on_questions) {
      const depRow = this.db.select().from(questions).where(eq(questions.questionId, depId)).get();
      if (!depRow) {
        throw new Error(`depends_on_missing:${depId}`);
      }
    }

    this.db.transaction((tx) => {
      tx.insert(questions)
        .values({
          questionId: question.question_id,
          questionType: question.question_type,
          phaseId: question.phase_id ?? null,
          parentQuestionId: question.parent_question_id ?? null,
          fromRole: question.from_role,
          fromAgentId: question.from_agent_id,
          toRole: question.to_role,
          state: 'queued',
          ownerAgentId: null,
          payload: JSON.stringify(question),
          correlationId: envelope.correlation_id ?? null,
          envelopeJson: JSON.stringify(envelope),
          answerJson: null,
          escalationJson: null,
          priority: question.priority,
          createdAt: now,
          updatedAt: now,
          deadlineAt: question.deadline_at ? new Date(question.deadline_at) : null,
          leaseExpiresAt: null,
        })
        .run();

      for (const depId of question.depends_on_questions) {
        tx.insert(questionDependencies)
          .values({ questionId: question.question_id, dependsOnQuestionId: depId })
          .run();
      }
    });

    const out: HubSubmitQuestionOutput = {
      question_id: question.question_id,
      state: 'queued',
    };

    if (idempKey) {
      this.store.setIdempotencyResult(idempKey, out, IDEMPOTENCY_TTL_MS);
    }

    return out;
  }

  claimQuestion(role: string, agentId: string, leaseDurationMs: number): HubClaimQuestionOutput {
    const now = new Date();
    this.releaseExpiredLeases(now);

    const readyStmt = this.sqlite.prepare(
      `SELECT question_id FROM questions
       WHERE state = 'queued'
         AND to_role = ?
         AND (
           SELECT COUNT(*) FROM question_dependencies qd
           JOIN questions dep ON dep.question_id = qd.depends_on_question_id
           WHERE qd.question_id = questions.question_id AND dep.state != 'answered'
         ) = 0
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`,
    );
    const readyRow = readyStmt.get(role) as { question_id: string } | undefined;

    if (!readyRow) {
      return { envelope: null };
    }

    const leaseUntil = new Date(now.getTime() + leaseDurationMs);
    const upd = this.db
      .update(questions)
      .set({
        state: 'claimed',
        ownerAgentId: agentId,
        leaseExpiresAt: leaseUntil,
        updatedAt: now,
      })
      .where(and(eq(questions.questionId, readyRow.question_id), eq(questions.state, 'queued')))
      .run();

    if (upd.changes !== 1) {
      return { envelope: null };
    }

    const row = this.db.select().from(questions).where(eq(questions.questionId, readyRow.question_id)).get();
    if (!row) {
      return { envelope: null };
    }

    return {
      envelope: JSON.parse(row.envelopeJson) as PacketEnvelope,
      question_state: row.state as QuestionState,
    };
  }

  markInProgress(questionId: string, agentId: string): void {
    const now = new Date();
    const upd = this.db
      .update(questions)
      .set({ state: 'in_progress', updatedAt: now })
      .where(
        and(
          eq(questions.questionId, questionId),
          eq(questions.state, 'claimed'),
          eq(questions.ownerAgentId, agentId),
        ),
      )
      .run();
    if (upd.changes !== 1) {
      throw new Error('mark_in_progress_denied');
    }
  }

  submitAnswer(envelope: PacketEnvelope): HubSubmitAnswerOutput {
    const idempKey = envelope.idempotency_key;
    if (idempKey) {
      const cached = this.store.getIdempotencyResult(idempKey) as HubSubmitAnswerOutput | null;
      if (cached && typeof cached === 'object' && 'question_id' in cached) {
        return cached;
      }
    }

    if (envelope.packet_type !== 'answer') {
      throw new Error('envelope_type_mismatch: expected answer');
    }

    const answer = answerPacketSchema.parse(envelope.payload);

    const invariantCheck = validateAnswerInvariants(answer);
    if (!invariantCheck.ok) {
      throw new Error(`answer_invariant_violation: ${invariantCheck.violations.join('; ')}`);
    }

    const row = this.db.select().from(questions).where(eq(questions.questionId, answer.question_id)).get();
    if (!row) {
      throw new Error('question_not_found');
    }
    if (row.state !== 'claimed' && row.state !== 'in_progress') {
      throw new Error(`answer_denied: question state is ${row.state}`);
    }

    const now = new Date();
    this.db
      .update(questions)
      .set({
        state: 'answered',
        answerJson: JSON.stringify(envelope),
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(questions.questionId, answer.question_id))
      .run();

    const out: HubSubmitAnswerOutput = {
      question_id: answer.question_id,
      state: 'answered',
    };

    if (idempKey) {
      this.store.setIdempotencyResult(idempKey, out, IDEMPOTENCY_TTL_MS);
    }

    return out;
  }

  submitEscalation(envelope: PacketEnvelope): HubSubmitEscalationOutput {
    const idempKey = envelope.idempotency_key;
    if (idempKey) {
      const cached = this.store.getIdempotencyResult(idempKey) as HubSubmitEscalationOutput | null;
      if (cached && typeof cached === 'object' && 'question_id' in cached) {
        return cached;
      }
    }

    if (envelope.packet_type !== 'escalation') {
      throw new Error('envelope_type_mismatch: expected escalation');
    }

    const escalation = escalationPacketSchema.parse(envelope.payload);

    const row = this.db.select().from(questions).where(eq(questions.questionId, escalation.question_id)).get();
    if (!row) {
      throw new Error('question_not_found');
    }
    if (row.state !== 'claimed' && row.state !== 'in_progress') {
      throw new Error(`escalation_denied: question state is ${row.state}`);
    }

    const now = new Date();
    this.db
      .update(questions)
      .set({
        state: 'escalated',
        escalationJson: JSON.stringify(envelope),
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(questions.questionId, escalation.question_id))
      .run();

    const out: HubSubmitEscalationOutput = {
      question_id: escalation.question_id,
      state: 'escalated',
      escalated_to: escalation.escalate_to,
    };

    if (idempKey) {
      this.store.setIdempotencyResult(idempKey, out, IDEMPOTENCY_TTL_MS);
    }

    return out;
  }

  resolveEscalation(input: {
    escalation_id: string;
    original_question_id: string;
    agent_id: string;
    action: 'revise' | 'cancel';
    revised_envelope?: PacketEnvelope;
  }): HubResolveEscalationOutput {
    const row = this.db.select().from(questions).where(eq(questions.questionId, input.original_question_id)).get();
    if (!row) {
      throw new Error('question_not_found');
    }
    if (row.state !== 'escalated') {
      throw new Error(`resolve_denied: question state is ${row.state}, expected escalated`);
    }

    const now = new Date();

    if (input.action === 'cancel') {
      this.db
        .update(questions)
        .set({ state: 'cancelled', updatedAt: now })
        .where(eq(questions.questionId, input.original_question_id))
        .run();

      return {
        original_question_id: input.original_question_id,
        original_state: 'cancelled',
      };
    }

    if (!input.revised_envelope) {
      throw new Error('revise requires revised_envelope');
    }

    this.db
      .update(questions)
      .set({ state: 'cancelled', updatedAt: now })
      .where(eq(questions.questionId, input.original_question_id))
      .run();

    const newResult = this.submitQuestion(input.revised_envelope);

    return {
      original_question_id: input.original_question_id,
      original_state: 'cancelled',
      new_question_id: newResult.question_id,
    };
  }

  getQuestion(questionId: string): {
    question_id: string;
    state: QuestionState;
    envelope: PacketEnvelope;
    answer_envelope: PacketEnvelope | null;
    escalation_envelope: PacketEnvelope | null;
  } | undefined {
    const row = this.db.select().from(questions).where(eq(questions.questionId, questionId)).get();
    if (!row) return undefined;
    return {
      question_id: row.questionId,
      state: row.state as QuestionState,
      envelope: JSON.parse(row.envelopeJson) as PacketEnvelope,
      answer_envelope: row.answerJson ? JSON.parse(row.answerJson) as PacketEnvelope : null,
      escalation_envelope: row.escalationJson ? JSON.parse(row.escalationJson) as PacketEnvelope : null,
    };
  }

  private releaseExpiredLeases(now: Date): void {
    this.db
      .update(questions)
      .set({
        state: 'queued',
        ownerAgentId: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(questions.state, 'claimed'),
          lte(questions.leaseExpiresAt, now),
        ),
      )
      .run();
  }
}
