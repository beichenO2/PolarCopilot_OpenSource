/**
 * QuestionService unit tests — validates the full question lifecycle:
 * submit → claim → in_progress → answer/escalate → resolve
 *
 * Each test group uses its own DB to avoid cross-test state leaks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHubDatabase, type HubDb, type HubSqlite } from '../../src/persistence/db.js';
import { HubStore } from '../../src/persistence/store.js';
import { QuestionService } from '../../src/questions/service.js';
import type { PacketEnvelope } from '../../src/protocol/packets.js';

const NOW = '2026-04-15T14:23:18.123Z';

function makeQuestionEnvelope(
  questionId: string,
  overrides: Record<string, unknown> = {},
): PacketEnvelope {
  const question = {
    question_id: questionId,
    question_type: 'implementation_task',
    from_role: 'controller',
    from_agent_id: 'ctrl-01',
    to_role: 'worker',
    objective: 'Implement fuzzy search',
    reason: 'Phase 1 requirement',
    scope: { files_to_read: [], files_to_write: ['src/search.ts'], directories: [] },
    constraints: [],
    acceptance: [{
      id: 'AC-1',
      description: 'npm test passes',
      type: 'command',
      command: 'npm test',
      expected: 'all pass',
      required: true,
    }],
    context: {
      project_summary: 'gsd-2 multi-agent hub',
      phase_summary: 'Add search',
      recent_history: [],
      non_goals: [],
    },
    context_refs: [],
    output_contract: {
      must_include: ['changed_files'],
      allowed_formats: ['answer_packet', 'escalation_packet'],
    },
    depends_on_questions: [],
    depends_on_tasks: [],
    created_at: NOW,
    priority: 0,
    ...overrides,
  };

  return {
    packet_id: `PKT-${questionId}`,
    packet_type: 'question',
    packet_version: '1.0',
    correlation_id: 'CORR-001',
    idempotency_key: `IDEM-${questionId}`,
    attempt: 1,
    emitted_at: NOW,
    payload: question,
  };
}

function makeAnswerEnvelope(questionId: string, idempSuffix = ''): PacketEnvelope {
  return {
    packet_id: `PKT-A-${questionId}`,
    packet_type: 'answer',
    packet_version: '1.0',
    correlation_id: 'CORR-001',
    idempotency_key: `IDEM-A-${questionId}${idempSuffix}`,
    attempt: 1,
    emitted_at: NOW,
    payload: {
      question_id: questionId,
      answer_id: `A-${questionId}`,
      answer_type: 'implementation_result',
      from_role: 'worker',
      from_agent_id: 'w-01',
      to_role: 'controller',
      status: 'completed',
      summary: 'Done',
      blockers: [],
      acceptance_result: {
        passed: true,
        items: [{ acceptance_id: 'AC-1', passed: true, evidence: ['5/5 tests pass'] }],
        commands_run: ['npm test'],
      },
      created_at: NOW,
      changed_files: ['src/search.ts'],
      commands_run: ['npm test'],
      artifacts: [],
    },
  };
}

function makeEscalationEnvelope(questionId: string): PacketEnvelope {
  return {
    packet_id: `PKT-E-${questionId}`,
    packet_type: 'escalation',
    packet_version: '1.0',
    correlation_id: 'CORR-001',
    idempotency_key: `IDEM-E-${questionId}`,
    attempt: 1,
    emitted_at: NOW,
    payload: {
      question_id: questionId,
      escalation_id: `ESC-${questionId}`,
      from_role: 'worker',
      from_agent_id: 'w-01',
      escalate_to: 'controller',
      blocker_type: 'missing_constraint',
      blocker_summary: 'Unknown if DB index is allowed',
      impact: 'Determines approach',
      proposed_options: [
        { id: 'opt-1', description: 'Add index', recommended: true },
        { id: 'opt-2', description: 'No index', recommended: false },
      ],
      default_option_id: 'opt-1',
      created_at: NOW,
    },
  };
}

function createTestService(): { service: QuestionService; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gsd-qs-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  const { sqlite, db } = createHubDatabase(dbPath);
  const store = new HubStore(db);
  const service = new QuestionService(db, sqlite, store);
  return { service, tmpDir };
}

describe('QuestionService', () => {
  let service: QuestionService;
  let tmpDir: string;

  beforeEach(() => {
    const ctx = createTestService();
    service = ctx.service;
    tmpDir = ctx.tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Submit ───────────────────────────────────────────────────

  it('submits a question and returns queued state', () => {
    const env = makeQuestionEnvelope('Q-001');
    const result = service.submitQuestion(env);
    expect(result.question_id).toBe('Q-001');
    expect(result.state).toBe('queued');
  });

  it('idempotent submit returns same result', () => {
    const env = makeQuestionEnvelope('Q-002');
    const r1 = service.submitQuestion(env);
    const r2 = service.submitQuestion(env);
    expect(r1).toEqual(r2);
  });

  it('rejects non-question envelope type', () => {
    const env = makeQuestionEnvelope('Q-003');
    env.packet_type = 'answer';
    expect(() => service.submitQuestion(env)).toThrow('envelope_type_mismatch');
  });

  // ─── Claim ────────────────────────────────────────────────────

  it('claims a queued question for the target role', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-010'));

    const claimed = service.claimQuestion('worker', 'w-01', 600_000);
    expect(claimed.envelope).not.toBeNull();
    expect(claimed.question_state).toBe('claimed');

    const q = service.getQuestion('Q-010');
    expect(q?.state).toBe('claimed');
  });

  it('returns null when no questions for role', () => {
    const result = service.claimQuestion('supervisor', 'sup-01', 600_000);
    expect(result.envelope).toBeNull();
  });

  // ─── In Progress ──────────────────────────────────────────────

  it('marks claimed question as in_progress', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-020'));
    service.claimQuestion('worker', 'w-01', 600_000);

    service.markInProgress('Q-020', 'w-01');

    const q = service.getQuestion('Q-020');
    expect(q?.state).toBe('in_progress');
  });

  // ─── Answer ───────────────────────────────────────────────────

  it('closes question with answer from claimed state', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-030'));
    service.claimQuestion('worker', 'w-01', 600_000);

    const result = service.submitAnswer(makeAnswerEnvelope('Q-030'));
    expect(result.question_id).toBe('Q-030');
    expect(result.state).toBe('answered');

    const q = service.getQuestion('Q-030');
    expect(q?.state).toBe('answered');
    expect(q?.answer_envelope).not.toBeNull();
  });

  it('closes question with answer from in_progress state', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-030b'));
    service.claimQuestion('worker', 'w-01', 600_000);
    service.markInProgress('Q-030b', 'w-01');

    const result = service.submitAnswer(makeAnswerEnvelope('Q-030b'));
    expect(result.state).toBe('answered');
  });

  it('rejects answer for already answered question', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-031'));
    service.claimQuestion('worker', 'w-01', 600_000);
    service.submitAnswer(makeAnswerEnvelope('Q-031'));

    expect(() => service.submitAnswer(makeAnswerEnvelope('Q-031', '-dupe'))).toThrow('answer_denied');
  });

  it('rejects answer without acceptance_result when status=completed', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-032'));
    service.claimQuestion('worker', 'w-01', 600_000);

    const aEnv = makeAnswerEnvelope('Q-032');
    (aEnv.payload as any).acceptance_result = undefined;
    expect(() => service.submitAnswer(aEnv)).toThrow('answer_invariant_violation');
  });

  // ─── Escalation ───────────────────────────────────────────────

  it('closes question with escalation', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-040'));
    service.claimQuestion('worker', 'w-01', 600_000);

    const result = service.submitEscalation(makeEscalationEnvelope('Q-040'));
    expect(result.question_id).toBe('Q-040');
    expect(result.state).toBe('escalated');
    expect(result.escalated_to).toBe('controller');

    const q = service.getQuestion('Q-040');
    expect(q?.state).toBe('escalated');
    expect(q?.escalation_envelope).not.toBeNull();
  });

  // ─── Resolve Escalation ───────────────────────────────────────

  it('resolves escalation by cancelling', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-050'));
    service.claimQuestion('worker', 'w-01', 600_000);
    service.submitEscalation(makeEscalationEnvelope('Q-050'));

    const result = service.resolveEscalation({
      escalation_id: 'ESC-Q-050',
      original_question_id: 'Q-050',
      agent_id: 'ctrl-01',
      action: 'cancel',
    });
    expect(result.original_state).toBe('cancelled');
    expect(result.new_question_id).toBeUndefined();
  });

  it('resolves escalation by revising with a new question', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-060'));
    service.claimQuestion('worker', 'w-01', 600_000);
    service.submitEscalation(makeEscalationEnvelope('Q-060'));

    const revisedEnv = makeQuestionEnvelope('Q-060-rev');
    const result = service.resolveEscalation({
      escalation_id: 'ESC-Q-060',
      original_question_id: 'Q-060',
      agent_id: 'ctrl-01',
      action: 'revise',
      revised_envelope: revisedEnv,
    });

    expect(result.original_state).toBe('cancelled');
    expect(result.new_question_id).toBe('Q-060-rev');

    const oldQ = service.getQuestion('Q-060');
    expect(oldQ?.state).toBe('cancelled');

    const newQ = service.getQuestion('Q-060-rev');
    expect(newQ?.state).toBe('queued');
  });

  // ─── Dependencies ─────────────────────────────────────────────

  it('does not claim question with unresolved dependencies', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-DEP-1'));
    service.submitQuestion(makeQuestionEnvelope('Q-DEP-2', {
      depends_on_questions: ['Q-DEP-1'],
    }));

    const claimed = service.claimQuestion('worker', 'w-01', 600_000);
    const claimedPayload = claimed.envelope?.payload as any;
    expect(claimedPayload?.question_id).toBe('Q-DEP-1');

    const claimed2 = service.claimQuestion('worker', 'w-02', 600_000);
    expect(claimed2.envelope).toBeNull();
  });

  it('allows claiming dependent question after dep is answered', () => {
    service.submitQuestion(makeQuestionEnvelope('Q-DEP-A'));
    service.submitQuestion(makeQuestionEnvelope('Q-DEP-B', {
      depends_on_questions: ['Q-DEP-A'],
    }));

    service.claimQuestion('worker', 'w-01', 600_000);
    service.submitAnswer(makeAnswerEnvelope('Q-DEP-A'));

    const claimed = service.claimQuestion('worker', 'w-01', 600_000);
    const claimedPayload = claimed.envelope?.payload as any;
    expect(claimedPayload?.question_id).toBe('Q-DEP-B');
  });

  // ─── getQuestion ──────────────────────────────────────────────

  it('returns undefined for non-existent question', () => {
    expect(service.getQuestion('Q-NONEXISTENT')).toBeUndefined();
  });
});
