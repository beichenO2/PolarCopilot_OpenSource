import { describe, expect, it } from 'vitest';
import {
  roleSchema,
  questionTypeSchema,
  questionStateSchema,
  timestampSchema,
  packetEnvelopeSchema,
  questionPacketSchema,
  answerPacketSchema,
  implementationAnswerPacketSchema,
  decompositionAnswerPacketSchema,
  reviewAnswerPacketSchema,
  verificationAnswerPacketSchema,
  escalationPacketSchema,
  validateAnswerInvariants,
  wrapEnvelope,
  type QuestionPacket,
  type AnswerPacket,
  type EscalationPacket,
} from '../../src/protocol/packets.js';

const NOW = '2026-04-15T14:23:18.123Z';

function makeMinimalQuestion(overrides: Partial<QuestionPacket> = {}): QuestionPacket {
  return {
    question_id: 'Q-001',
    question_type: 'implementation_task',
    from_role: 'controller',
    from_agent_id: 'ctrl-01',
    to_role: 'worker',
    objective: 'Implement fuzzy search in src/search.ts',
    reason: 'Phase 1 requires keyword matching',
    scope: { files_to_read: [], files_to_write: ['src/search.ts'], directories: [] },
    constraints: [],
    acceptance: [{
      id: 'AC-1',
      description: 'npm test passes',
      type: 'command',
      command: 'npm test -- search.test.ts',
      expected: 'all pass',
      required: true,
    }],
    context: {
      project_summary: 'gsd-2 multi-agent hub',
      phase_summary: 'Add search feature',
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
}

// ─── §2 Enums ──────────────────────────────────────────────────────

describe('roleSchema', () => {
  it('accepts valid roles', () => {
    for (const r of ['proxy', 'controller', 'worker', 'supervisor', 'clk', 'standby']) {
      expect(roleSchema.parse(r)).toBe(r);
    }
  });

  it('rejects unknown roles', () => {
    expect(() => roleSchema.parse('admin')).toThrow();
  });
});

describe('questionTypeSchema', () => {
  it('accepts all question types', () => {
    for (const qt of ['phase_objective', 'decomposition_task', 'implementation_task', 'review_task', 'verification_task']) {
      expect(questionTypeSchema.parse(qt)).toBe(qt);
    }
  });
});

describe('questionStateSchema', () => {
  it('covers full lifecycle', () => {
    const states = ['queued', 'claimed', 'in_progress', 'answered', 'escalated', 'timed_out', 'cancelled'];
    for (const s of states) {
      expect(questionStateSchema.parse(s)).toBe(s);
    }
  });
});

// ─── §2.4 Timestamps ──────────────────────────────────────────────

describe('timestampSchema', () => {
  it('accepts RFC3339 with milliseconds', () => {
    expect(timestampSchema.parse('2026-04-15T14:23:18.123Z')).toBe('2026-04-15T14:23:18.123Z');
  });

  it('accepts RFC3339 without milliseconds', () => {
    expect(timestampSchema.parse('2026-04-15T14:23:18Z')).toBe('2026-04-15T14:23:18Z');
  });

  it('rejects plain date strings', () => {
    expect(() => timestampSchema.parse('2026-04-15')).toThrow();
  });

  it('rejects unix timestamps', () => {
    expect(() => timestampSchema.parse(1713189798)).toThrow();
  });
});

// ─── §3 PacketEnvelope ─────────────────────────────────────────────

describe('packetEnvelopeSchema', () => {
  const validEnvelope = {
    packet_id: 'PKT-001',
    packet_type: 'question' as const,
    packet_version: '1.0' as const,
    correlation_id: 'CORR-001',
    idempotency_key: 'IDEM-001',
    attempt: 1,
    emitted_at: NOW,
    payload: { question_id: 'Q-001' },
  };

  it('parses valid envelope', () => {
    const result = packetEnvelopeSchema.parse(validEnvelope);
    expect(result.packet_id).toBe('PKT-001');
    expect(result.packet_version).toBe('1.0');
  });

  it('defaults attempt to 1', () => {
    const { attempt: _, ...noAttempt } = validEnvelope;
    const result = packetEnvelopeSchema.parse(noAttempt);
    expect(result.attempt).toBe(1);
  });

  it('rejects wrong packet_version', () => {
    expect(() => packetEnvelopeSchema.parse({ ...validEnvelope, packet_version: '2.0' })).toThrow();
  });

  it('allows optional causation_id', () => {
    const result = packetEnvelopeSchema.parse({ ...validEnvelope, causation_id: 'CAUSE-001' });
    expect(result.causation_id).toBe('CAUSE-001');
  });
});

// ─── §4 QuestionPacket ─────────────────────────────────────────────

describe('questionPacketSchema', () => {
  it('parses minimal valid question', () => {
    const q = makeMinimalQuestion();
    const result = questionPacketSchema.parse(q);
    expect(result.question_id).toBe('Q-001');
    expect(result.from_role).toBe('controller');
    expect(result.to_role).toBe('worker');
  });

  it('rejects empty acceptance', () => {
    const q = makeMinimalQuestion({ acceptance: [] as any });
    expect(() => questionPacketSchema.parse(q)).toThrow();
  });

  it('rejects free-string role', () => {
    const q = makeMinimalQuestion({ from_role: 'admin' as any });
    expect(() => questionPacketSchema.parse(q)).toThrow();
  });

  it('uses deadline_at instead of timeout_ms', () => {
    const q = makeMinimalQuestion({ deadline_at: '2026-04-15T15:00:00Z' });
    const result = questionPacketSchema.parse(q);
    expect(result.deadline_at).toBe('2026-04-15T15:00:00Z');
    expect((result as any).timeout_ms).toBeUndefined();
  });

  it('acceptance items are structured objects', () => {
    const q = makeMinimalQuestion();
    const result = questionPacketSchema.parse(q);
    expect(result.acceptance[0].id).toBe('AC-1');
    expect(result.acceptance[0].type).toBe('command');
  });

  it('defaults arrays to empty', () => {
    const q = makeMinimalQuestion();
    delete (q as any).constraints;
    delete (q as any).context_refs;
    delete (q as any).depends_on_questions;
    delete (q as any).depends_on_tasks;
    const result = questionPacketSchema.parse(q);
    expect(result.constraints).toEqual([]);
    expect(result.context_refs).toEqual([]);
    expect(result.depends_on_questions).toEqual([]);
    expect(result.depends_on_tasks).toEqual([]);
  });
});

// ─── §5 AnswerPacket discriminated union ───────────────────────────

describe('answerPacketSchema', () => {
  const baseAnswer = {
    question_id: 'Q-001',
    answer_id: 'A-001',
    from_role: 'worker' as const,
    from_agent_id: 'w-01',
    to_role: 'controller' as const,
    status: 'completed' as const,
    summary: 'Implemented fuzzy search',
    blockers: [],
    acceptance_result: {
      passed: true,
      items: [{ acceptance_id: 'AC-1', passed: true, evidence: ['5/5 tests pass'] }],
      commands_run: ['npm test'],
    },
    created_at: NOW,
  };

  it('parses implementation_result', () => {
    const pkt = {
      ...baseAnswer,
      answer_type: 'implementation_result' as const,
      changed_files: ['src/search.ts'],
      commands_run: ['npm test'],
      artifacts: [],
    };
    const result = answerPacketSchema.parse(pkt);
    expect(result.answer_type).toBe('implementation_result');
  });

  it('parses decomposition_result', () => {
    const pkt = {
      ...baseAnswer,
      answer_type: 'decomposition_result' as const,
      from_role: 'controller' as const,
      from_agent_id: 'ctrl-01',
      to_role: 'proxy' as const,
      decomposition_summary: { total_questions: 3, notes: [] },
      submitted_question_ids: ['Q-T1', 'Q-T2', 'Q-T3'],
    };
    const result = answerPacketSchema.parse(pkt);
    expect(result.answer_type).toBe('decomposition_result');
    if (result.answer_type === 'decomposition_result') {
      expect(result.submitted_question_ids).toHaveLength(3);
    }
  });

  it('parses review_result', () => {
    const pkt = {
      ...baseAnswer,
      answer_type: 'review_result' as const,
      from_role: 'supervisor' as const,
      from_agent_id: 'sup-01',
      review: { verdict: 'pass' as const, findings: [], required_fixes: [], risk_level: 'low' as const },
    };
    const result = answerPacketSchema.parse(pkt);
    expect(result.answer_type).toBe('review_result');
  });

  it('parses verification_result', () => {
    const pkt = {
      ...baseAnswer,
      answer_type: 'verification_result' as const,
      from_role: 'supervisor' as const,
      from_agent_id: 'sup-01',
      verification: { verdict: 'pass' as const, findings: [], missing_acceptance_ids: [], risk_level: 'low' as const },
    };
    const result = answerPacketSchema.parse(pkt);
    expect(result.answer_type).toBe('verification_result');
  });

  it('rejects unknown answer_type', () => {
    const pkt = { ...baseAnswer, answer_type: 'magic_result' };
    expect(() => answerPacketSchema.parse(pkt)).toThrow();
  });
});

// ─── §5.7 AnswerPacket invariants ──────────────────────────────────

describe('validateAnswerInvariants', () => {
  it('passes for completed with acceptance_result', () => {
    const pkt: AnswerPacket = {
      question_id: 'Q-001',
      answer_id: 'A-001',
      answer_type: 'implementation_result',
      from_role: 'worker',
      from_agent_id: 'w-01',
      to_role: 'controller',
      status: 'completed',
      summary: 'Done',
      blockers: [],
      acceptance_result: { passed: true, items: [], commands_run: [] },
      created_at: NOW,
      changed_files: [],
      commands_run: [],
      artifacts: [],
    };
    expect(validateAnswerInvariants(pkt)).toEqual({ ok: true });
  });

  it('fails for completed without acceptance_result', () => {
    const pkt: AnswerPacket = {
      question_id: 'Q-001',
      answer_id: 'A-001',
      answer_type: 'implementation_result',
      from_role: 'worker',
      from_agent_id: 'w-01',
      to_role: 'controller',
      status: 'completed',
      summary: 'Done',
      blockers: [],
      created_at: NOW,
      changed_files: [],
      commands_run: [],
      artifacts: [],
    };
    const result = validateAnswerInvariants(pkt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain('status=completed requires acceptance_result');
    }
  });

  it('fails for completed with non-empty blockers', () => {
    const pkt: AnswerPacket = {
      question_id: 'Q-001',
      answer_id: 'A-001',
      answer_type: 'implementation_result',
      from_role: 'worker',
      from_agent_id: 'w-01',
      to_role: 'controller',
      status: 'completed',
      summary: 'Done',
      blockers: ['something is wrong'],
      acceptance_result: { passed: true, items: [], commands_run: [] },
      created_at: NOW,
      changed_files: [],
      commands_run: [],
      artifacts: [],
    };
    const result = validateAnswerInvariants(pkt);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toContain('blockers non-empty but status=completed');
    }
  });

  it('passes for partial status with blockers', () => {
    const pkt: AnswerPacket = {
      question_id: 'Q-001',
      answer_id: 'A-001',
      answer_type: 'implementation_result',
      from_role: 'worker',
      from_agent_id: 'w-01',
      to_role: 'controller',
      status: 'partial',
      summary: 'Partially done',
      blockers: ['missing DB access'],
      created_at: NOW,
      changed_files: [],
      commands_run: [],
      artifacts: [],
    };
    expect(validateAnswerInvariants(pkt)).toEqual({ ok: true });
  });
});

// ─── §6 EscalationPacket ──────────────────────────────────────────

describe('escalationPacketSchema', () => {
  const validEscalation = {
    question_id: 'Q-T123',
    escalation_id: 'ESC-001',
    from_role: 'worker' as const,
    from_agent_id: 'w001',
    escalate_to: 'controller' as const,
    blocker_type: 'missing_constraint' as const,
    blocker_summary: 'Unknown whether DB index is allowed',
    impact: 'Determines performance approach',
    proposed_options: [
      { id: 'opt-1', description: 'Add trigram index', recommended: true },
      { id: 'opt-2', description: 'Use LIKE filter', recommended: false },
    ],
    default_option_id: 'opt-1',
    created_at: NOW,
  };

  it('parses valid escalation', () => {
    const result = escalationPacketSchema.parse(validEscalation);
    expect(result.blocker_type).toBe('missing_constraint');
    expect(result.proposed_options).toHaveLength(2);
  });

  it('rejects default_option_id referencing non-existent option', () => {
    const bad = { ...validEscalation, default_option_id: 'opt-99' };
    expect(() => escalationPacketSchema.parse(bad)).toThrow();
  });

  it('allows omitted default_option_id', () => {
    const { default_option_id: _, ...noDefault } = validEscalation;
    const result = escalationPacketSchema.parse(noDefault);
    expect(result.default_option_id).toBeUndefined();
  });

  it('rejects empty proposed_options', () => {
    const bad = { ...validEscalation, proposed_options: [] };
    expect(() => escalationPacketSchema.parse(bad)).toThrow();
  });

  it('uses roleSchema for escalate_to', () => {
    const bad = { ...validEscalation, escalate_to: 'admin' };
    expect(() => escalationPacketSchema.parse(bad)).toThrow();
  });
});

// ─── wrapEnvelope helper ──────────────────────────────────────────

describe('wrapEnvelope', () => {
  it('creates a valid envelope', () => {
    const q = makeMinimalQuestion();
    const env = wrapEnvelope(q, {
      packet_id: 'PKT-001',
      packet_type: 'question',
      correlation_id: 'CORR-001',
      idempotency_key: 'IDEM-001',
    });

    expect(env.packet_version).toBe('1.0');
    expect(env.attempt).toBe(1);
    expect(env.payload).toBe(q);
    expect(packetEnvelopeSchema.parse(env)).toBeDefined();
  });

  it('propagates causation_id', () => {
    const q = makeMinimalQuestion();
    const env = wrapEnvelope(q, {
      packet_id: 'PKT-002',
      packet_type: 'question',
      correlation_id: 'CORR-001',
      causation_id: 'PKT-001',
      idempotency_key: 'IDEM-002',
      attempt: 3,
    });

    expect(env.causation_id).toBe('PKT-001');
    expect(env.attempt).toBe(3);
  });
});
