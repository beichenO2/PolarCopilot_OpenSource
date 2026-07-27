import type { RrMessage, RrSession, RrSessionStatus } from '../types/rr'

export const DEFAULT_RR_AGENT_NAME = 'Rr Agent'
export const DEFAULT_RR_AGENT_ROLE = 'general-purpose'

const labels: Record<RrSessionStatus, string> = {
  online: '在线',
  waiting: '轮询中',
  working: '执行中',
  offline: '离线',
}

const tones: Record<RrSessionStatus, string> = {
  online: 'bg-hub-green/15 text-hub-green border-hub-green/30',
  waiting: 'bg-cyan-400/10 text-cyan-300 border-cyan-400/30',
  working: 'bg-hub-accent/15 text-hub-accent border-hub-accent/30',
  offline: 'bg-hub-border text-hub-text-muted border-hub-border',
}

export function statusLabel(status: RrSessionStatus): string { return labels[status] }
export function statusTone(status: RrSessionStatus): string { return tones[status] }

export function shouldNotifyRr(message: Pick<RrMessage, 'msgId' | 'role'>, seen: Set<string>): boolean {
  return message.role === 'assistant' && !seen.has(message.msgId)
}

export function buildRrLaunchPrompt(session: RrSession): string {
  return `【Rr · 本地无限 MCP】
使用 Cursor 中的 rr-chat MCP 接入本机 Rr。Rr 完全在本地运行。

立即调用 register_session：
- name: "${session.name}"
- launchId: "${session.launchId ?? ''}"
- 如需重连，同时传回 sessionId: "${session.sessionId}"

注册后记住返回的 sessionId，先用 reply_message 回传一条简短接入消息并设置 title，然后调用 wait_message，timeoutMs=60000。

循环协议：
1. 每次收到 [RR_MSG · USER_TASK] 后直接完成任务。
2. 用 reply_message 交付结果，随后立即再次调用 wait_message。
3. [POLL_TICK] 是保活任务，简短完成后继续 wait_message，不是停止信号。
4. 主会话可用 list_subagents 查找面板中已打开“子 Agent”开关的会话，并用 dispatch_subagent_task 派发。
5. 子 Agent 收到 [RR_MSG · AGENT_TASK] 后，以 report_task_progress 上报进度，最终必须调用 complete_subagent_task 回流结果并释放 busy 锁，然后继续 wait_message。

所有调用都必须使用 rr-chat 的结构化 MCP 工具。`
}

