import type { RrSession } from './types.js';

export function buildRrLaunchPrompt(session: Pick<RrSession, 'sessionId' | 'name' | 'launchId'>): string {
  return `【Rr · 本地无限 MCP】
使用 Cursor 中的 rr-chat MCP 接入本机 Rr。Rr 完全在本地运行。

立即调用 register_session（必须带上 Hub 预分配的 sessionId，禁止留空或新建重复会话）：
- sessionId: "${session.sessionId}"
- name: "${session.name}"
- launchId: "${session.launchId ?? ''}"

注册后记住返回的 sessionId，先用 reply_message 回传一条简短接入消息并设置 title，然后调用 wait_message，timeoutMs=60000。

循环协议：
1. 每次收到 [RR_MSG · USER_TASK] 后直接完成任务。
2. 用 reply_message 交付结果，随后立即再次调用 wait_message。
3. [POLL_TICK] 是保活任务，简短完成后继续 wait_message，不是停止信号。
4. 主会话可用 list_subagents 查找面板中已打开“子 Agent”开关的会话，并用 dispatch_subagent_task 派发。
5. 子 Agent 收到 [RR_MSG · AGENT_TASK] 后，以 report_task_progress 上报进度，最终必须调用 complete_subagent_task 回流结果并释放 busy 锁，然后继续 wait_message。

AFK 自动化（可选）：
- 启动：npm run rr:orchestrator -- start（需 ~/.cursor/afk/ACTIVE）
- Orchestrator 通过 Hub POST 注入任务（等同 Hub 面板发送）

所有调用都必须使用 rr-chat 的结构化 MCP 工具。`;
}
