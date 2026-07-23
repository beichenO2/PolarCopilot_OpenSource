import type { XjAgentSlot, XjMessage, XjSession, XjSessionStatus } from '../types/xj'

export const DEFAULT_XJ_MODES = ['夜晚自动化挂机任务', 'AI 破甲（道德经Max）'] as const
export const DEFAULT_XJ_AGENT_NAME = '通用 Agent'
export const DEFAULT_XJ_AGENT_ROLE = 'general-purpose'

export interface XjSessionFamilyRequest {
  launchId: string
  name: string
  role: string
  title: string
  modes: string[]
  subagent_count: 2
}

interface XjLaunchPromptInput {
  launchId: string
  name: string
  role?: string
  modes: readonly string[]
  agentSlot?: XjAgentSlot
  parentSessionId?: string
}

const labels: Record<XjSessionStatus, string> = {
  connecting: '连接中',
  online: '在线',
  pending: '有新消息',
  waiting: '等待消息',
  working: '执行中',
  paused: '已暂停',
  completed: '已完成',
  offline: '离线',
}

const tones: Record<XjSessionStatus, string> = {
  connecting: 'bg-hub-accent text-white',
  online: 'bg-hub-green/15 text-hub-green border-hub-green/30',
  pending: 'bg-hub-yellow/15 text-hub-yellow border-hub-yellow/30',
  waiting: 'bg-cyan-400/10 text-cyan-300 border-cyan-400/30',
  working: 'bg-hub-accent/15 text-hub-accent border-hub-accent/30',
  paused: 'bg-hub-orange/15 text-hub-orange border-hub-orange/30',
  completed: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
  offline: 'bg-hub-border text-hub-text-muted border-hub-border',
}

export function statusLabel(status: XjSessionStatus): string {
  return labels[status]
}

export function statusTone(status: XjSessionStatus): string {
  return tones[status]
}

export function shouldNotifyXj(message: Pick<XjMessage, 'id' | 'role'>, seen: Set<string>): boolean {
  return message.role === 'assistant' && !seen.has(message.id)
}

export function buildXjSessionFamilyRequest(launchId: string, title: string): XjSessionFamilyRequest {
  return {
    launchId,
    name: DEFAULT_XJ_AGENT_NAME,
    role: DEFAULT_XJ_AGENT_ROLE,
    title,
    modes: [...DEFAULT_XJ_MODES],
    subagent_count: 2,
  }
}

export function buildXjLaunchPrompt({ launchId, name, role, modes, agentSlot, parentSessionId }: XjLaunchPromptInput): string {
  const modeLines = modes.map((mode) => `- "${mode}"`).join('\n')
  const roleLine = role ? `，role 使用「${role}」` : ''
  const isSubagent = agentSlot === 'subagent-1' || agentSlot === 'subagent-2'
  const identityLine = isSubagent
    ? `本会话是子 Agent，父会话为「${parentSessionId ?? '由 HUB 自动关联'}」。只接收并完成主 Agent 派发的任务；每条委派都必须自行执行、验证并给出可直接合并的最终结果，不得返回半成品。reply_message 成功后，回复会自动回流主 Agent。`
    : '本会话是主 Agent，并固定拥有两个子 Agent。每收到一条 USER_TASK，都先调用 list_subagents；将可独立执行、调查或验证的部分分别用 dispatch_subagent_task 派给两个子 Agent，主 Agent 同时推进其余工作。子 Agent 不在线时不得卡住，主 Agent直接接管。收到 XJ_MSG · AGENT_RESULT 后必须整合结果并继续执行，不能把子 Agent 结果原样丢给用户。'
  const oneShotContract = `【单次输入直达完成 · 本会话全部任务】
- 一条用户消息就是一份完整工作单。收到后自行理解目标、制定 TODO、作出合理工程判断并立刻执行。
- 不得在任务中途停下来等待确认、方案选择、计划审批或普通决策；不得只汇报计划、局部结果或“下一步”。只有缺少不可推断的外部信息、权限或凭据且所有替代路径均失败时，才允许回传一次明确阻塞。
- 开工、里程碑和子任务回收只用 report_progress 持久化，禁止用 reply_message 发送中途回执。遇到失败要记录证据、换路径并继续。
- 必须持续执行到所有 TODO 清零、必要验证通过、子 Agent 结果已回收并整合。不得因单次工具失败、上下文压缩或 wait_message 超时自行收尾。
- 只允许在整项任务完成后调用一次 reply_message 交付最终结果；suggestions:string[] 也只能随最终交付发送，不能用来把未完成工作重新交给用户。`
  return `【工作模式 · MCP（轮询会话模式）】
启动 PolarCopilot XJ 持续会话。

本对话框身份令牌 launchId「${launchId}」。请通过 polarcop-xj 的真实结构化工具接入；首次注册不要传 sessionId，断线重连时继续使用同一 launchId，已有 sessionId 时一并传回。

register_session 的原生参数就是 launchId；直接原样传入，不要转换字段，也不要先猜测其他参数名。

${identityLine}

${oneShotContract}

立即调用 register_session，名称「${name}」${roleLine}，并启用：
modes:
${modeLines}

注册成功后：
1. 显眼回显返回的 sessionId 与名称。
2. 首次调用 reply_message 自报已接入，并用 title 设置一个不超过 10 字的会话标题。
3. 立即调用 wait_message，timeoutMs=300000；超时后继续调用。
4. 收到消息后直接执行；执行过程中用 report_progress 持久化进度、TODO 和验证证据，不发送中途 reply_message。
5. 主 Agent 按上面的 1+2 编队协议自动派发、回收并整合；子 Agent 完成当前委派后一次性回传最终结果。
6. 整项工作完成后才用 reply_message 回传最终结果，随后立即再次调用 wait_message 接收下一份完整工作单。
7. 只有 wait_message 返回 paused/completed 且 next_tool 为 null 时才停止持续轮询。

register_session、reply_message、wait_message 和 report_progress 必须使用 MCP 结构化工具调用，不要在正文中伪造工具结果。`
}

export function getXjAgentFamily(sessions: XjSession[], selectedId: string): {
  main: XjSession
  subagents: XjSession[]
} | null {
  const selected = sessions.find((session) => session.id === selectedId)
  if (!selected) return null
  const mainId = selected.parentSessionId ?? selected.id
  const main = sessions.find((session) => session.id === mainId)
  if (!main) return null
  const subagents = sessions
    .filter((session) => session.parentSessionId === main.id)
    .sort((a, b) => (a.agentSlot ?? '').localeCompare(b.agentSlot ?? ''))
  return { main, subagents }
}

export function getXjTaskTargetId(sessions: XjSession[], selectedId: string): string {
  const selected = sessions.find((session) => session.id === selectedId)
  return selected?.parentSessionId ?? selected?.id ?? selectedId
}
