import type { RrAfkMode } from './types.js';

export function isSoloMasterOrchestratorMode(mode?: RrAfkMode | string | null): boolean {
  return mode === 'solo' || !mode;
}

/** Mode=solo 主会话编排纪律 — 禁止亲自读写仓库源代码 */
export function buildSoloMasterOrchestratorLines(): string[] {
  return [
    '## 主会话编排纪律（Mode=solo · 硬）',
    '- **禁止亲自读/写仓库源代码**：不得用 Read/Grep/Glob/StrReplace/Write/Edit/Delete 等触达 `projectRoot` 下代码与配置；不得 Shell 执行会读改仓库的命令（build/test/lint/typecheck 由子 Agent 执行并回报）。',
    '- **需要读代码 → 派子 Agent 侦查**：`dispatch_subagent_task` 发自包含 brief（路径范围、问题、VERIFY_CMD、结论须附路径+行号或命令真实输出）。',
    '- **需要改代码 → 派子 Agent 实现**：同上，写明 Allowed writes、DONE_WHEN、VERIFY_CMD；主会话只核验 AGENT_RESULT 与验证摘要，不亲自改 hunk。',
    '- **主会话允许**：拆 TODO、写 `tasks/<taskId>/` 内 DECISIONS/TODO/CRITERIA 元数据、list_subagents、dispatch/wake 子池、汇总验证、reply_message → wait_message。',
    '- 子 Agent 全 busy/offline → dispatch 等待或 PolarBudget 候补（`POST /api/lease/wait`）；**禁止**主会话降级亲自读改写码；候补超时再 PAUSE。',
  ];
}

export function buildSoloMasterReplyFormat(): string[] {
  return [
    '## reply 格式（主会话 · 每单元）',
    '1. 状态一行（taskId / unit / status）',
    '2. 本轮 dispatch 了哪些子 Agent、brief 摘要（禁止写「我改了某文件」除非来自 AGENT_RESULT）',
    '3. 子 Agent 回报验证摘要或 NOT RUN + 原因',
    '4. 下一单元计划（继续 dispatch 或等待 AGENT_RESULT）',
    '5. reply_message 后立刻 wait_message',
  ];
}

export function buildSubagentDispatchContent(input: {
  task: string;
  projectRoot: string;
  kind: 'research' | 'implement';
}): string {
  const roleLine = input.kind === 'research'
    ? '【子 Agent · 只读侦查】'
    : '【子 Agent · 实现/改码】';
  const permissionLine = input.kind === 'research'
    ? '默认只读；主会话未授权写文件时禁止 StrReplace/Write。'
    : '主会话已在 brief 中授权的路径可写；超出范围禁止。';

  return [
    roleLine,
    '',
    input.task,
    '',
    `项目根：${input.projectRoot}`,
    permissionLine,
    '要求：自包含任务；禁止套娃开子代理；每条结论附路径+行号或命令+真实输出。',
    '完成：report_task_progress → complete_subagent_task → wait_message。',
  ].join('\n');
}

export function classifyDispatchKind(task: string): 'research' | 'implement' {
  if (/调研|审查|对比|排查|分析|research|audit|review|read|explore|侦查/i.test(task)) {
    return 'research';
  }
  return 'implement';
}
