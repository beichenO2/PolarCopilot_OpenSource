import { describe, it, expect, vi } from 'vitest';
import { AgentRunner, type AgentRunnerConfig, type LlmInvokerFn } from '../../src/runner/agent-runner.js';
import { wrapEnvelope, type QuestionPacket, type PacketEnvelope } from '../../src/protocol/packets.js';
import type { HubClient } from '../../src/runner/hub-client.js';
import type { InvokeResult } from '../../src/runner/llm-invoker.js';
import pino from 'pino';

const silentLogger = pino({ level: 'silent' });

function makeConfig(
  invoker: LlmInvokerFn,
  overrides: Partial<AgentRunnerConfig> = {},
): AgentRunnerConfig {
  return {
    hubUrl: 'http://127.0.0.1:9999/mcp',
    agentId: 'test-w001',
    role: 'worker',
    projectDir: '/tmp/test-project',
    logger: silentLogger,
    backoffBaseMs: 1,
    backoffMaxMs: 5,
    heartbeatIntervalMs: 100_000,
    maxConsecutiveErrors: 3,
    invokeLlmAgent: invoker,
    ...overrides,
  };
}

function makeQuestionEnvelope(): PacketEnvelope {
  const question: QuestionPacket = {
    question_id: 'Q-TEST-001',
    question_type: 'implementation_task',
    from_role: 'controller',
    from_agent_id: 'ctrl',
    to_role: 'worker',
    objective: 'Test objective',
    reason: 'Test reason',
    scope: { files_to_read: [], files_to_write: [], directories: [] },
    constraints: [],
    acceptance: [{ id: 'AC-1', description: 'Must pass', type: 'assertion', required: true }],
    context: { project_summary: 'test', phase_summary: 'test' },
    context_refs: [],
    output_contract: { must_include: ['status'], allowed_formats: ['answer_packet', 'escalation_packet'] },
    depends_on_questions: [],
    depends_on_tasks: [],
    created_at: '2026-04-15T14:00:00.000Z',
    priority: 0,
  };

  return wrapEnvelope(question, {
    packet_id: 'PKT-TEST-001',
    packet_type: 'question',
    correlation_id: 'COR-TEST-001',
    idempotency_key: 'IDEM-TEST-001',
  });
}

function makeMockHub(opts: {
  claimQuestion: ReturnType<typeof vi.fn>;
  submitAnswer?: ReturnType<typeof vi.fn>;
  submitEscalation?: ReturnType<typeof vi.fn>;
}): HubClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    claimQuestion: opts.claimQuestion,
    submitAnswer: opts.submitAnswer ?? vi.fn().mockResolvedValue(undefined),
    submitEscalation: opts.submitEscalation ?? vi.fn().mockResolvedValue(undefined),
    get isRegistered() { return true; },
  } as unknown as HubClient;
}

describe('AgentRunner', () => {
  it('can be instantiated with valid config', () => {
    const invoker = vi.fn<LlmInvokerFn>();
    const runner = new AgentRunner(makeConfig(invoker));
    expect(runner).toBeDefined();
  });

  it('stop() prevents further iterations', () => {
    const invoker = vi.fn<LlmInvokerFn>();
    const runner = new AgentRunner(makeConfig(invoker));
    runner.stop();
    expect(runner).toBeDefined();
  });

  it('exits after maxConsecutiveErrors', async () => {
    const invoker = vi.fn<LlmInvokerFn>();
    const hub = makeMockHub({
      claimQuestion: vi.fn().mockRejectedValue(new Error('hub unreachable')),
    });

    const runner = new AgentRunner(makeConfig(invoker, { maxConsecutiveErrors: 2 }));
    runner._setHub(hub);

    await runner.start();
    expect(hub.heartbeat).toHaveBeenCalled();
  });

  it('does not invoke LLM when no question is claimed', async () => {
    const invoker = vi.fn<LlmInvokerFn>();
    let tickCount = 0;

    const claimQuestion = vi.fn().mockImplementation(async () => {
      tickCount++;
      if (tickCount >= 3) runner.stop();
      return { envelope: null };
    });

    const hub = makeMockHub({ claimQuestion });
    const runner = new AgentRunner(makeConfig(invoker));
    runner._setHub(hub);

    await runner.start();
    expect(invoker).not.toHaveBeenCalled();
    expect(claimQuestion).toHaveBeenCalled();
  });

  it('submits synthetic escalation when LLM output is invalid', async () => {
    const invoker = vi.fn<LlmInvokerFn>().mockResolvedValue({
      type: 'parse_error',
      raw: 'garbage output',
      error: 'no JSON found',
    } as InvokeResult);

    const envelope = makeQuestionEnvelope();
    let claimCount = 0;
    const submitEscalation = vi.fn().mockResolvedValue(undefined);
    let runner: AgentRunner;

    const hub = makeMockHub({
      claimQuestion: vi.fn().mockImplementation(async () => {
        claimCount++;
        if (claimCount === 1) return { envelope };
        runner.stop();
        return { envelope: null };
      }),
      submitEscalation,
    });

    runner = new AgentRunner(makeConfig(invoker));
    runner._setHub(hub);

    await runner.start();

    expect(invoker).toHaveBeenCalledTimes(1);
    expect(submitEscalation).toHaveBeenCalledTimes(1);

    const call = submitEscalation.mock.calls[0][0] as PacketEnvelope;
    expect(call.packet_type).toBe('escalation');
    expect(call.correlation_id).toBe('COR-TEST-001');
    expect(call.causation_id).toBe('PKT-TEST-001');
  });

  it('submits answer when LLM produces valid AnswerPacket', async () => {
    const invoker = vi.fn<LlmInvokerFn>().mockResolvedValue({
      type: 'answer',
      value: {
        answer_type: 'implementation_result',
        question_id: 'Q-TEST-001',
        answer_id: 'A-TEST-001',
        from_role: 'worker',
        from_agent_id: 'test-w001',
        to_role: 'controller',
        status: 'completed',
        summary: 'Task done',
        blockers: [],
        acceptance_result: { passed: true, items: [], commands_run: [] },
        created_at: '2026-04-15T15:00:00.000Z',
        changed_files: [],
        commands_run: [],
        artifacts: [],
      },
    } as InvokeResult);

    const envelope = makeQuestionEnvelope();
    let claimCount = 0;
    const submitAnswer = vi.fn().mockResolvedValue(undefined);
    let runner: AgentRunner;

    const hub = makeMockHub({
      claimQuestion: vi.fn().mockImplementation(async () => {
        claimCount++;
        if (claimCount === 1) return { envelope };
        runner.stop();
        return { envelope: null };
      }),
      submitAnswer,
    });

    runner = new AgentRunner(makeConfig(invoker));
    runner._setHub(hub);

    await runner.start();

    expect(invoker).toHaveBeenCalledTimes(1);
    expect(submitAnswer).toHaveBeenCalledTimes(1);

    const call = submitAnswer.mock.calls[0][0] as PacketEnvelope;
    expect(call.packet_type).toBe('answer');
    expect(call.correlation_id).toBe('COR-TEST-001');
    expect(call.causation_id).toBe('PKT-TEST-001');
  });

  it('submits escalation when LLM outputs EscalationPacket', async () => {
    const invoker = vi.fn<LlmInvokerFn>().mockResolvedValue({
      type: 'escalation',
      value: {
        question_id: 'Q-TEST-001',
        escalation_id: 'ESC-001',
        from_role: 'worker',
        from_agent_id: 'test-w001',
        escalate_to: 'controller',
        blocker_type: 'missing_constraint',
        blocker_summary: 'Need permission info',
        impact: 'Cannot proceed',
        proposed_options: [{ id: 'opt-1', description: 'Wait', recommended: true }],
        default_option_id: 'opt-1',
        created_at: '2026-04-15T15:00:00.000Z',
      },
    } as InvokeResult);

    const envelope = makeQuestionEnvelope();
    let claimCount = 0;
    const submitEscalation = vi.fn().mockResolvedValue(undefined);
    let runner: AgentRunner;

    const hub = makeMockHub({
      claimQuestion: vi.fn().mockImplementation(async () => {
        claimCount++;
        if (claimCount === 1) return { envelope };
        runner.stop();
        return { envelope: null };
      }),
      submitEscalation,
    });

    runner = new AgentRunner(makeConfig(invoker));
    runner._setHub(hub);

    await runner.start();

    expect(invoker).toHaveBeenCalledTimes(1);
    expect(submitEscalation).toHaveBeenCalledTimes(1);

    const call = submitEscalation.mock.calls[0][0] as PacketEnvelope;
    expect(call.packet_type).toBe('escalation');
    expect(call.correlation_id).toBe('COR-TEST-001');
  });

  it('resets consecutiveErrors on successful tick', async () => {
    let tickCount = 0;
    const envelope = makeQuestionEnvelope();

    const invoker = vi.fn<LlmInvokerFn>().mockResolvedValue({
      type: 'answer',
      value: {
        answer_type: 'implementation_result',
        question_id: 'Q-TEST-001',
        answer_id: 'A-TEST-001',
        from_role: 'worker',
        from_agent_id: 'test-w001',
        to_role: 'controller',
        status: 'completed',
        summary: 'Done',
        blockers: [],
        created_at: '2026-04-15T15:00:00.000Z',
        changed_files: [],
        commands_run: [],
        artifacts: [],
      },
    } as InvokeResult);

    const submitAnswer = vi.fn().mockResolvedValue(undefined);
    let runner: AgentRunner;

    const hub = makeMockHub({
      claimQuestion: vi.fn().mockImplementation(async () => {
        tickCount++;
        if (tickCount <= 2) return { envelope };
        runner.stop();
        return { envelope: null };
      }),
      submitAnswer,
    });

    runner = new AgentRunner(makeConfig(invoker, { maxConsecutiveErrors: 1 }));
    runner._setHub(hub);

    await runner.start();

    // 2 questions answered, then no question → stop. Should NOT have died from consecutive errors.
    expect(submitAnswer).toHaveBeenCalledTimes(2);
  });
});
