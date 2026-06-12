import { randomUUID } from 'node:crypto';
import type { PacketEnvelope, AnswerPacket, EscalationPacket } from '../protocol/packets.js';
import { wrapEnvelope } from '../protocol/packets.js';
import type { HubClient } from './hub-client.js';
import type { InvokeResult } from './llm-invoker.js';

export type LlmInvokerFn = (prompt: string) => Promise<InvokeResult>;

export interface AgentRunnerConfig {
  hubUrl: string;
  agentId: string;
  role: string;
  projectDir: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  backoffBaseMs: number;
  backoffMaxMs: number;
  heartbeatIntervalMs: number;
  maxConsecutiveErrors: number;
  invokeLlmAgent: LlmInvokerFn;
}

/**
 * AgentRunner — the main loop for a worker agent.
 * Connects to hub, claims questions, invokes LLM, submits answers/escalations.
 */
export class AgentRunner {
  private config: AgentRunnerConfig;
  private running = false;
  private consecutiveErrors = 0;
  private hub: HubClient | null = null;

  constructor(config: AgentRunnerConfig) {
    this.config = config;
  }

  /** Internal: inject a mock HubClient for testing. */
  _setHub(hub: HubClient): void {
    this.hub = hub;
  }

  stop(): void {
    this.running = false;
  }

  async start(): Promise<void> {
    this.running = true;
    this.consecutiveErrors = 0;

    const hub = this.hub ?? this.createHubClient();
    if (!hub) return;

    await hub.connect();
    await hub.register(this.config.agentId);

    try {
      while (this.running) {
        try {
          await hub.heartbeat();

          const claimed = await hub.claimQuestion();
          if (!claimed.envelope) {
            this.consecutiveErrors = 0;
            await this.sleep(50);
            continue;
          }

          const question = claimed.envelope.payload as Record<string, unknown> | undefined;
          if (!question) {
            this.consecutiveErrors++;
            if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
              this.stop();
              return;
            }
            continue;
          }

          const prompt = this.buildPrompt(question);
          const result = await this.config.invokeLlmAgent(prompt);

          if (result.type === 'answer') {
            const answerEnv = this.wrapAnswer(claimed.envelope, result.value);
            await hub.submitAnswer(answerEnv);
            this.consecutiveErrors = 0;
          } else if (result.type === 'escalation') {
            const escEnv = this.wrapEscalation(claimed.envelope, result.value);
            await hub.submitEscalation(escEnv);
            this.consecutiveErrors = 0;
          } else {
            // parse_error — submit synthetic escalation
            const escEnv = this.wrapParseErrorEscalation(claimed.envelope, result);
            await hub.submitEscalation(escEnv);
            this.consecutiveErrors = 0;
          }
        } catch (err) {
          this.config.logger.error(`tick error: ${(err as Error).message}`);
          this.consecutiveErrors++;
          if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
            this.stop();
            return;
          }
          const backoff = Math.min(
            this.config.backoffBaseMs * 2 ** (this.consecutiveErrors - 1),
            this.config.backoffMaxMs,
          );
          await this.sleep(backoff);
        }
      }
    } finally {
      await hub.disconnect();
    }
  }

  private buildPrompt(question: Record<string, unknown>): string {
    const lines: string[] = [];
    if (typeof question.objective === 'string') lines.push(`Objective: ${question.objective}`);
    if (typeof question.reason === 'string') lines.push(`Reason: ${question.reason}`);
    return lines.join('\n');
  }

  private wrapAnswer(questionEnv: PacketEnvelope, answer: AnswerPacket): PacketEnvelope {
    return wrapEnvelope(answer, {
      packet_id: `ANS-${randomUUID()}`,
      packet_type: 'answer',
      correlation_id: questionEnv.correlation_id,
      causation_id: questionEnv.packet_id,
      idempotency_key: `IDEM-${randomUUID()}`,
    });
  }

  private wrapEscalation(questionEnv: PacketEnvelope, escalation: EscalationPacket): PacketEnvelope {
    return wrapEnvelope(escalation, {
      packet_id: `ESC-${randomUUID()}`,
      packet_type: 'escalation',
      correlation_id: questionEnv.correlation_id,
      causation_id: questionEnv.packet_id,
      idempotency_key: `IDEM-${randomUUID()}`,
    });
  }

  private wrapParseErrorEscalation(questionEnv: PacketEnvelope, result: { raw: string; error: string }): PacketEnvelope {
    const escalation: EscalationPacket = {
      question_id: (questionEnv.payload as Record<string, unknown>).question_id as string,
      escalation_id: `ESC-${randomUUID()}`,
      from_role: this.config.role as EscalationPacket['from_role'],
      from_agent_id: this.config.agentId,
      escalate_to: 'controller',
      blocker_type: 'missing_context',
      blocker_summary: `LLM parse error: ${result.error}`,
      impact: 'Cannot process question',
      proposed_options: [{ id: 'opt-1', description: 'Re-queue question', recommended: true }],
      default_option_id: 'opt-1',
      created_at: new Date().toISOString(),
    };
    return wrapEnvelope(escalation, {
      packet_id: `ESC-${randomUUID()}`,
      packet_type: 'escalation',
      correlation_id: questionEnv.correlation_id,
      causation_id: questionEnv.packet_id,
      idempotency_key: `IDEM-${randomUUID()}`,
    });
  }

  private createHubClient(): HubClient | null {
    // In production, this would create a real HTTP-based HubClient.
    // For tests, use _setHub to inject a mock.
    this.config.logger.warn('No HubClient available — runner cannot connect');
    return null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
