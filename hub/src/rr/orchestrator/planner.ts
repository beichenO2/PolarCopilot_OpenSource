import { createHash } from 'node:crypto';
import { parseCriteriaSummary, parseTodoItems } from './afk-state.js';
import type { PlannerAction, PlannerInput } from './types.js';

function hashContent(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function idleMs(session: PlannerInput['session'], now: number): number {
  return Math.max(0, now - session.lastActiveAt);
}

function lastAssistantSummary(history: PlannerInput['history']): string | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role === 'assistant') return message.content.slice(0, 400);
  }
  return null;
}

function buildInjectPrompt(input: PlannerInput, nextTodo: string | null, reason: string): string {
  const { config, state, afk } = input;
  const criteria = parseCriteriaSummary(afk.criteriaText);
  const lines = [
    config.injectPrefix,
    '',
    `轮次：${state.loopCount + 1}/${afk.maxLoops}`,
    `触发：${reason}`,
    '',
    '## 挂机契约（必须遵守）',
    '- 不向用户提问；在授权范围内自行决断并继续。',
    '- 完成一个原子单元后 reply_message，然后立刻 wait_message。',
    '- 任何「已完成/已修复/已通过」必须附本轮真实验证输出；无法验证标 NOT RUN。',
    '- 禁止空转 survey；每轮必须有可验证产物变化。',
    '',
    '## 项目根目录',
    config.projectRoot,
  ];
  if (nextTodo) {
    lines.push('', '## 本轮首选原子任务', nextTodo);
  } else if (afk.todoText) {
    lines.push('', '## TODO 摘要', '请读取项目 TODO 并选择下一项未完成、可验证、最小范围的原子任务。');
  } else {
    lines.push('', '## 任务', '继续推进当前 AFK 目标，选择最小可验证的原子单元。');
  }
  if (criteria.length > 0) {
    lines.push('', '## 验收判据（摘要）', ...criteria.map((line) => `- ${line}`));
  }
  lines.push(
    '',
    '## 收尾要求',
    '1. 执行 → 验证 → reply_message 交付（含证据）',
    '2. 立即 wait_message 等待下一条（不要结束 turn）',
    '3. 若有可并行调研/审查且子 Agent 空闲，可 dispatch_subagent_task',
  );
  return lines.join('\n');
}

function buildWakePrompt(input: PlannerInput): string {
  return [
    input.config.injectPrefix,
    '',
    '【唤醒】Rr 会话已离线或未在 wait_message。请立刻：',
    '1. 若已有 sessionId，直接 wait_message 恢复轮询（不要重新 register）',
    '2. 读取 TODO/CRITERIA，继续上一原子任务',
    '3. reply_message 后立刻 wait_message',
  ].join('\n');
}

function pickResearchTask(input: PlannerInput): string | null {
  const todos = parseTodoItems(input.afk.todoText);
  const candidate = todos.find((item) => /调研|审查|对比|排查|分析|research|audit|review/i.test(item));
  return candidate ?? null;
}

/** Agent mid-turn: do not inject/wake even if Hub marks online=false due to stale lastActiveAt. */
function isAgentBusy(session: PlannerInput['session']): boolean {
  if (session.activeTask) return true;
  if (session.status === 'working') return true;
  const status = (session.agentStatus || '').toLowerCase();
  return status === 'working' || status === 'developing';
}

function withinCooldown(lastInjectedAt: number | null, now: number, cooldownMs: number): boolean {
  return Boolean(lastInjectedAt && now - lastInjectedAt < cooldownMs);
}

export function planNextAction(input: PlannerInput, now = Date.now()): PlannerAction {
  const { config, state, afk, session, subagents } = input;

  if (afk.paused) return { kind: 'pause', reason: 'AFK PAUSE 文件存在' };
  if (afk.done) return { kind: 'done', reason: 'AFK DONE 已写入' };
  if (state.loopCount >= afk.maxLoops) return { kind: 'pause', reason: `已达 maxLoops=${afk.maxLoops}` };
  if (!afk.active) return { kind: 'noop', reason: 'AFK AFK inactive（缺少 ~/.cursor/afk/ACTIVE）' };

  // Hard gate: never pile into a non-empty inbox (fixes offline wake flood).
  if (session.pendingMessages > 0) {
    return { kind: 'noop', reason: `inbox 已有 ${session.pendingMessages} 条待处理，禁止再投` };
  }

  // Hard gate: never interrupt an in-flight agent turn.
  if (isAgentBusy(session)) {
    return {
      kind: 'noop',
      reason: `master 忙碌中（status=${session.status} agentStatus=${session.agentStatus}）`,
    };
  }

  // Global inject/wake cooldown — protects against SSE burst double-fire.
  if (withinCooldown(state.lastInjectedAt, now, Math.min(config.idleInjectDelayMs, config.offlineWakeDelayMs))) {
    return { kind: 'noop', reason: '注入/唤醒全局冷却中' };
  }

  const idle = idleMs(session, now);
  const todos = parseTodoItems(afk.todoText);
  const nextTodo = todos[0] ?? null;

  if (session.status === 'offline' || !session.online) {
    if (idle < config.offlineWakeDelayMs) {
      return { kind: 'noop', reason: `会话 offline，等待 ${config.offlineWakeDelayMs}ms 再唤醒` };
    }
    if (withinCooldown(state.lastInjectedAt, now, config.offlineWakeDelayMs)) {
      return { kind: 'noop', reason: `唤醒冷却中（${config.offlineWakeDelayMs}ms）` };
    }
    const wake = buildWakePrompt(input);
    const digest = hashContent(wake);
    if (state.lastInjectedHash === digest && withinCooldown(state.lastInjectedAt, now, config.offlineWakeDelayMs * 2)) {
      return { kind: 'noop', reason: '重复唤醒冷却中' };
    }
    return { kind: 'wake', content: wake, reason: 'master 会话 offline，需要唤醒' };
  }

  // Only continue AFK when the agent is actually blocked in wait_message.
  // Previously `status === 'online'` also fell through and could inject while not waiting.
  if (!session.waiting || session.status !== 'waiting') {
    return {
      kind: 'noop',
      reason: `未在 wait_message（waiting=${session.waiting} status=${session.status}）`,
    };
  }

  if (idle < config.idleInjectDelayMs) {
    return { kind: 'noop', reason: `waiting 但 idle=${idle}ms < ${config.idleInjectDelayMs}ms` };
  }

  if (config.autoDispatchSubagents) {
    const idleSubagents = subagents.filter((agent) => agent.availability === 'idle');
    const research = pickResearchTask(input);
    if (idleSubagents.length > 0 && research) {
      return {
        kind: 'dispatch',
        targetSessionId: idleSubagents[0]!.sessionId,
        content: [
          '【子 Agent 任务 · 只读侦查 unless 主会话授权写】',
          '',
          research,
          '',
          '背景：主会话 AFK 挂机中；你负责并行完成上述调研/审查。',
          '要求：每条结论附文件路径+行号或命令+真实输出；禁止套娃开子代理。',
          `项目根：${config.projectRoot}`,
        ].join('\n'),
        reason: `并行派发调研任务给 idle 子 Agent (${idleSubagents[0]!.name})`,
      };
    }
  }

  const inject = buildInjectPrompt(input, nextTodo, `master waiting idle ${idle}ms`);
  const digest = hashContent(inject);
  if (state.lastInjectedHash === digest && withinCooldown(state.lastInjectedAt, now, config.idleInjectDelayMs)) {
    return { kind: 'noop', reason: '重复 prompt 已在冷却窗口内' };
  }

  return { kind: 'inject', content: inject, reason: `master waiting idle ${idle}ms` };
}

export function contentHash(content: string): string {
  return hashContent(content);
}

export { lastAssistantSummary };
