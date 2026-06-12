import { describe, it, expect } from 'vitest';
import { buildPrompt, parseLlmOutput } from '../../src/runner/llm-invoker.js';
import type { QuestionPacket, AnswerPacket, EscalationPacket } from '../../src/protocol/packets.js';

function makeQuestion(overrides: Partial<QuestionPacket> = {}): QuestionPacket {
  return {
    question_id: 'Q-001',
    question_type: 'implementation_task',
    from_role: 'controller',
    from_agent_id: 'ctrl',
    to_role: 'worker',
    objective: 'Implement the search endpoint',
    reason: 'User needs fuzzy search capability',
    scope: {
      files_to_read: ['src/search.ts'],
      files_to_write: ['src/search.ts'],
      directories: [],
    },
    constraints: ['No new npm dependencies'],
    acceptance: [
      {
        id: 'AC-1',
        description: 'Search endpoint returns results',
        type: 'command',
        command: 'npm test',
        required: true,
      },
    ],
    context: {
      project_summary: 'A Node.js API server',
      phase_summary: 'Phase 3: Search features',
      tech_stack: 'TypeScript, Express, SQLite',
      recent_history: [],
      non_goals: [],
    },
    context_refs: [],
    output_contract: {
      must_include: ['changed_files', 'status'],
      allowed_formats: ['answer_packet', 'escalation_packet'],
    },
    depends_on_questions: [],
    depends_on_tasks: [],
    created_at: '2026-04-15T14:00:00.000Z',
    priority: 0,
    ...overrides,
  } satisfies QuestionPacket;
}

describe('buildPrompt', () => {
  it('includes objective and reason', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('Implement the search endpoint');
    expect(prompt).toContain('User needs fuzzy search capability');
  });

  it('includes scope files', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('src/search.ts');
  });

  it('includes constraints', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('No new npm dependencies');
  });

  it('includes acceptance criteria with IDs', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('[AC-1]');
    expect(prompt).toContain('Search endpoint returns results');
  });

  it('includes output contract', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('answer_packet');
    expect(prompt).toContain('escalation_packet');
  });

  it('includes context', () => {
    const prompt = buildPrompt(makeQuestion());
    expect(prompt).toContain('A Node.js API server');
    expect(prompt).toContain('Phase 3: Search features');
    expect(prompt).toContain('TypeScript, Express, SQLite');
  });

  it('maps question_type to correct answer_type hint', () => {
    const worker = buildPrompt(makeQuestion({ question_type: 'implementation_task' }));
    expect(worker).toContain('implementation_result');

    const review = buildPrompt(makeQuestion({ question_type: 'review_task' }));
    expect(review).toContain('review_result');

    const verify = buildPrompt(makeQuestion({ question_type: 'verification_task' }));
    expect(verify).toContain('verification_result');

    const decompose = buildPrompt(makeQuestion({ question_type: 'decomposition_task' }));
    expect(decompose).toContain('decomposition_result');
  });
});

describe('parseLlmOutput', () => {
  it('parses a valid AnswerPacket', () => {
    const answer: AnswerPacket = {
      answer_type: 'implementation_result',
      question_id: 'Q-001',
      answer_id: 'A-001',
      from_role: 'worker',
      from_agent_id: 'w001',
      to_role: 'controller',
      status: 'completed',
      summary: 'Implemented search endpoint',
      blockers: [],
      acceptance_result: {
        passed: true,
        items: [{ acceptance_id: 'AC-1', passed: true, evidence: ['all tests pass'] }],
        commands_run: ['npm test'],
      },
      created_at: '2026-04-15T15:00:00.000Z',
      changed_files: ['src/search.ts'],
      commands_run: ['npm test'],
      artifacts: [],
    };

    const result = parseLlmOutput(JSON.stringify(answer));
    expect(result.type).toBe('answer');
    if (result.type === 'answer') {
      expect(result.value.answer_type).toBe('implementation_result');
      expect(result.value.question_id).toBe('Q-001');
      expect(result.value.status).toBe('completed');
    }
  });

  it('parses an AnswerPacket wrapped in markdown', () => {
    const answer = {
      answer_type: 'implementation_result',
      question_id: 'Q-001',
      answer_id: 'A-001',
      from_role: 'worker',
      from_agent_id: 'w001',
      to_role: 'controller',
      status: 'completed',
      summary: 'Done',
      blockers: [],
      created_at: '2026-04-15T15:00:00.000Z',
      changed_files: [],
      commands_run: [],
      artifacts: [],
    };

    const wrapped = `Here is the result:\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``;
    const result = parseLlmOutput(wrapped);
    expect(result.type).toBe('answer');
  });

  it('parses a valid EscalationPacket', () => {
    const escalation: EscalationPacket = {
      question_id: 'Q-001',
      escalation_id: 'ESC-001',
      from_role: 'worker',
      from_agent_id: 'w001',
      escalate_to: 'controller',
      blocker_type: 'missing_constraint',
      blocker_summary: 'Need to know if index creation is allowed',
      impact: 'Cannot proceed without database permission decision',
      proposed_options: [
        { id: 'opt-1', description: 'Create index', recommended: true },
        { id: 'opt-2', description: 'Skip index', recommended: false },
      ],
      default_option_id: 'opt-1',
      created_at: '2026-04-15T15:00:00.000Z',
    };

    const result = parseLlmOutput(JSON.stringify(escalation));
    expect(result.type).toBe('escalation');
    if (result.type === 'escalation') {
      expect(result.value.blocker_type).toBe('missing_constraint');
    }
  });

  it('returns parse_error for empty string', () => {
    const result = parseLlmOutput('');
    expect(result.type).toBe('parse_error');
    if (result.type === 'parse_error') {
      expect(result.error).toContain('no JSON object found');
    }
  });

  it('returns parse_error for invalid JSON', () => {
    const result = parseLlmOutput('{ broken json: }');
    expect(result.type).toBe('parse_error');
    if (result.type === 'parse_error') {
      expect(result.error).toContain('JSON parse error');
    }
  });

  it('returns parse_error for non-packet JSON', () => {
    const result = parseLlmOutput('{"foo": "bar"}');
    expect(result.type).toBe('parse_error');
    if (result.type === 'parse_error') {
      expect(result.error).toContain('neither AnswerPacket nor EscalationPacket');
    }
  });

  it('returns parse_error for malformed AnswerPacket', () => {
    const result = parseLlmOutput(JSON.stringify({
      answer_type: 'implementation_result',
      answer_id: 'A-001',
    }));
    expect(result.type).toBe('parse_error');
    if (result.type === 'parse_error') {
      expect(result.error).toContain('answer parse failed');
    }
  });

  it('returns parse_error for malformed EscalationPacket', () => {
    const result = parseLlmOutput(JSON.stringify({
      escalation_id: 'ESC-001',
      blocker_type: 'missing_constraint',
    }));
    expect(result.type).toBe('parse_error');
    if (result.type === 'parse_error') {
      expect(result.error).toContain('escalation parse failed');
    }
  });
});
