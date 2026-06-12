import type { Logger } from 'pino';
import type { BroadcastPublisher } from '../broadcast/publisher.js';

/**
 * Hub tool call 的估算 token 数。
 * 这是 Hub 侧的粗略估计（每次 MCP tool call ≈ 实际 150-300 token），
 * 不是 LLM context window 的精确统计。
 */
const TOKENS_PER_CALL: Record<string, number> = {
  worker: 200,
  controller: 150,
  supervisor: 120,
  proxy: 50,
  clk: 30,
};

const DEFAULT_TOKENS_PER_CALL = 150;

/** 阈值配置（可通过环境变量覆盖） */
interface IThresholdConfig {
  yellowToolCalls: number;
  redToolCalls: number;
  yellowMinutes: number;
  redMinutes: number;
  yellowTokens: number;
  redTokens: number;
}

function loadThresholds(): IThresholdConfig {
  return {
    yellowToolCalls: Number(process.env.PC_YELLOW_TOOL_CALLS ?? 200),
    redToolCalls: Number(process.env.PC_RED_TOOL_CALLS ?? 350),
    yellowMinutes: Number(process.env.PC_YELLOW_MINUTES ?? 45),
    redMinutes: Number(process.env.PC_RED_MINUTES ?? 90),
    yellowTokens: Number(process.env.PC_YELLOW_TOKENS ?? 200_000),
    redTokens: Number(process.env.PC_RED_TOKENS ?? 650_000),
  };
}

interface IAgentMetrics {
  agentId: string;
  role: string;
  toolCalls: number;
  startedAt: Date;
  lastActive: Date;
  estimatedTokens: number;
  warningLevel: 'none' | 'yellow' | 'red';
}

/**
 * 追踪每个 Agent 的活动指标，达到阈值时通过 Hub 广播生命周期信号。
 *
 * Agent 自身无法获取 token/context 信息，所以由 Hub 侧间接估算并通知。
 */
export class LifecycleTracker {
  private metrics = new Map<string, IAgentMetrics>();
  private thresholds: IThresholdConfig;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly publisher: BroadcastPublisher,
    private readonly logger: Logger,
  ) {
    this.thresholds = loadThresholds();
  }

  /** Agent 首次注册或重新出现时调用 */
  registerAgent(agentId: string, role: string): void {
    if (this.metrics.has(agentId)) {
      const existing = this.metrics.get(agentId)!;
      existing.lastActive = new Date();
      if (existing.role === 'unknown') existing.role = role;
      return;
    }
    this.metrics.set(agentId, {
      agentId,
      role,
      toolCalls: 0,
      startedAt: new Date(),
      lastActive: new Date(),
      estimatedTokens: 0,
      warningLevel: 'none',
    });
    this.logger.debug({ agentId, role }, 'lifecycle tracker: agent registered');
  }

  /** 每次 Agent 调用 Hub 工具时记录 */
  recordCall(agentId: string, _toolName: string): void {
    let m = this.metrics.get(agentId);
    if (!m) {
      this.registerAgent(agentId, 'unknown');
      m = this.metrics.get(agentId)!;
    }
    m.toolCalls++;
    m.lastActive = new Date();
    const tokensPerCall = TOKENS_PER_CALL[m.role] ?? DEFAULT_TOKENS_PER_CALL;
    m.estimatedTokens += tokensPerCall;
  }

  /** 检查所有 Agent 是否达到阈值，达到则广播信号 */
  checkThresholds(): void {
    const now = Date.now();
    for (const m of this.metrics.values()) {
      const runningMinutes = (now - m.startedAt.getTime()) / 60_000;
      const prevLevel = m.warningLevel;

      let newLevel: 'none' | 'yellow' | 'red' = 'none';
      if (
        m.toolCalls >= this.thresholds.redToolCalls ||
        runningMinutes >= this.thresholds.redMinutes ||
        m.estimatedTokens >= this.thresholds.redTokens
      ) {
        newLevel = 'red';
      } else if (
        m.toolCalls >= this.thresholds.yellowToolCalls ||
        runningMinutes >= this.thresholds.yellowMinutes ||
        m.estimatedTokens >= this.thresholds.yellowTokens
      ) {
        newLevel = 'yellow';
      }

      // 只在级别升级时广播（避免重复发送）
      if (newLevel === prevLevel) continue;
      if (newLevel === 'none') continue;
      if (prevLevel === 'red') continue; // 已经是最高级别

      m.warningLevel = newLevel;

      const payload =
        newLevel === 'yellow'
          ? {
              type: 'lifecycle_warning' as const,
              level: 'yellow' as const,
              tool_calls: m.toolCalls,
              estimated_tokens: m.estimatedTokens,
              running_minutes: Math.round(runningMinutes),
              advice: '开始收尾：写 checkpoint，完成当前任务后不要领新任务',
            }
          : {
              type: 'lifecycle_critical' as const,
              level: 'red' as const,
              tool_calls: m.toolCalls,
              estimated_tokens: m.estimatedTokens,
              running_minutes: Math.round(runningMinutes),
              advice: '立即收尾：强制写 checkpoint 并停止工作',
            };

      this.publisher.publish({
        sourceAgentId: 'hub-lifecycle',
        topic: `${m.agentId}.inbox`,
        payload,
      });

      this.logger.warn(
        { agentId: m.agentId, level: newLevel, toolCalls: m.toolCalls, estimatedTokens: m.estimatedTokens },
        `lifecycle threshold reached: ${newLevel}`,
      );
    }
  }

  /** 启动定时检查（默认 30 秒） */
  start(intervalMs: number = 30_000): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => this.checkThresholds(), intervalMs);
    this.logger.info({ intervalMs }, 'lifecycle tracker started');
  }

  /** 停止定时检查 */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  /** 获取某 Agent 的当前指标快照 */
  getMetrics(agentId: string): IAgentMetrics | undefined {
    return this.metrics.get(agentId);
  }

  /** 获取所有 Agent 指标（用于 hub_status） */
  getAllMetrics(): IAgentMetrics[] {
    return Array.from(this.metrics.values());
  }

  /** 移除已退出的 Agent */
  removeAgent(agentId: string): void {
    this.metrics.delete(agentId);
  }
}
