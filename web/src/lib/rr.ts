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

/** 新建进程标题：`主 · <stamp>` / `子N · <stamp>` */
const MAIN_TITLE_RE = /^主 · (.+)$/
const SUB_TITLE_RE = /^子\d+ · (.+)$/
const MAIN_NAME_RE = / · 主$/
const SUB_NAME_RE = / · 子\d+$/
/** 无标题 stamp 时，用创建时间窗把子挂到主（避免跨进程误挂） */
const PROCESS_CLUSTER_MS = 120_000

export interface RrSessionTreeNode {
  /** 稳定分组键：优先 stamp，否则 main.sessionId */
  key: string
  main: RrSession
  children: RrSession[]
}

export interface RrSessionForest {
  groups: RrSessionTreeNode[]
  /** 未归入任何主进程的会话（含孤立子 Agent、普通会话） */
  singles: RrSession[]
}

function titleStamp(session: RrSession): { kind: 'main' | 'sub'; stamp: string } | null {
  // 标题 stamp 本身已是强信号；不强制 isSubagent（面板开关/Agent 改写后可能丢失）
  const sub = session.title.match(SUB_TITLE_RE)
  if (sub) return { kind: 'sub', stamp: sub[1]! }
  const main = session.title.match(MAIN_TITLE_RE)
  if (main) return { kind: 'main', stamp: main[1]! }
  return null
}

function looksLikeProcessMain(session: RrSession): boolean {
  if (titleStamp(session)?.kind === 'sub' || SUB_NAME_RE.test(session.name)) return false
  return titleStamp(session)?.kind === 'main' || MAIN_NAME_RE.test(session.name)
}

function looksLikeProcessSub(session: RrSession): boolean {
  if (titleStamp(session)?.kind === 'main' || MAIN_NAME_RE.test(session.name)) return false
  return titleStamp(session)?.kind === 'sub' || session.isSubagent || SUB_NAME_RE.test(session.name)
}

/**
 * 将会话列表编成「主 + 可折叠子」森林。
 * 归属优先级：① 标题 stamp（主 · X / 子N · X）；
 * ② 名称约定（· 主 / · 子N）+ isSubagent + 创建时间邻近；
 * 拒绝跨 stamp 误挂。
 */
export function buildRrSessionForest(sessions: RrSession[]): RrSessionForest {
  const claimed = new Set<string>()
  const groups: RrSessionTreeNode[] = []

  const mainsByStamp = new Map<string, RrSession[]>()
  for (const session of sessions) {
    const meta = titleStamp(session)
    if (meta?.kind === 'main') {
      const list = mainsByStamp.get(meta.stamp) ?? []
      list.push(session)
      mainsByStamp.set(meta.stamp, list)
    }
  }

  for (const [stamp, mains] of mainsByStamp) {
    const orderedMains = [...mains].sort((a, b) => a.createdAt - b.createdAt)
    const subs = sessions
      .filter((session) => {
        if (claimed.has(session.sessionId)) return false
        const meta = titleStamp(session)
        return meta?.kind === 'sub' && meta.stamp === stamp
      })
      .sort((a, b) => a.createdAt - b.createdAt)

    // 同 stamp 多主（同秒连点）时按 createdAt 就近分配子，避免整坨挂错
    const buckets = orderedMains.map((main) => ({ main, children: [] as RrSession[] }))
    for (const sub of subs) {
      let best = 0
      let bestDist = Math.abs(sub.createdAt - buckets[0]!.main.createdAt)
      for (let i = 1; i < buckets.length; i += 1) {
        const dist = Math.abs(sub.createdAt - buckets[i]!.main.createdAt)
        if (dist < bestDist) {
          best = i
          bestDist = dist
        }
      }
      buckets[best]!.children.push(sub)
      claimed.add(sub.sessionId)
    }

    for (const bucket of buckets) {
      claimed.add(bucket.main.sessionId)
      groups.push({
        key: orderedMains.length === 1 ? stamp : `${stamp}::${bucket.main.sessionId}`,
        main: bucket.main,
        children: bucket.children,
      })
    }
  }

  // 回退：名称 · 主 / · 子N（或 isSubagent）+ 时间窗（标题被 Agent 改写后仍尽量成组）
  const leftoverMains = sessions
    .filter((session) => !claimed.has(session.sessionId) && looksLikeProcessMain(session))
    .sort((a, b) => a.createdAt - b.createdAt)

  const leftoverSubs = sessions
    .filter((session) => !claimed.has(session.sessionId) && looksLikeProcessSub(session))
    .sort((a, b) => a.createdAt - b.createdAt)

  for (let i = 0; i < leftoverMains.length; i += 1) {
    const main = leftoverMains[i]!
    const prevBoundary = i === 0 ? 0 : (leftoverMains[i - 1]!.createdAt + main.createdAt) / 2
    const nextBoundary = i + 1 >= leftoverMains.length
      ? Number.POSITIVE_INFINITY
      : (main.createdAt + leftoverMains[i + 1]!.createdAt) / 2
    const windowStart = Math.max(main.createdAt - PROCESS_CLUSTER_MS, prevBoundary)
    const windowEnd = Math.min(main.createdAt + PROCESS_CLUSTER_MS, nextBoundary)
    const children = leftoverSubs.filter((sub) => {
      if (claimed.has(sub.sessionId)) return false
      return sub.createdAt >= windowStart && sub.createdAt <= windowEnd
    })
    claimed.add(main.sessionId)
    for (const child of children) claimed.add(child.sessionId)
    groups.push({ key: main.sessionId, main, children })
  }

  // 组/单会话均按创建时间稳定排序（新→旧），绝不按 lastActiveAt / lastMessage 重排
  groups.sort((a, b) => (b.main.createdAt - a.main.createdAt) || a.main.sessionId.localeCompare(b.main.sessionId))

  const singles = sessions
    .filter((session) => !claimed.has(session.sessionId))
    .sort((a, b) => (b.createdAt - a.createdAt) || a.sessionId.localeCompare(b.sessionId))

  return { groups, singles }
}

const RR_LAST_READ_KEY = 'pc.rr.lastReadMessageTs'

/** 读取本地「已读水位」；用于左侧未读亮点，不参与列表排序 */
export function loadRrLastReadMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(RR_LAST_READ_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, number> = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

export function saveRrLastReadMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(RR_LAST_READ_KEY, JSON.stringify(map))
  } catch {
    // ignore quota / private mode
  }
}

/** 有比已读更新的消息时间戳时提示用户关注（不重排列表） */
export function sessionNeedsAttention(session: Pick<RrSession, 'sessionId' | 'lastMessageTs'>, lastRead: Record<string, number>): boolean {
  const ts = session.lastMessageTs ?? 0
  if (ts <= 0) return false
  return ts > (lastRead[session.sessionId] ?? 0)
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

AFK 自动化（可选）：
- 启动：\`bash Start/rr-orchestrator.sh\` 或 \`npm run rr:orchestrator -- run\`（需 ~/.cursor/afk/ACTIVE）
- Orchestrator 通过 Hub POST 注入任务（等同本面板发送）；CLI 负责读 TODO/CRITERIA 并续跑
- 与 Cursor /loop 兼容：stdout 输出 RR_ORCH_TICK sentinel 供会话内 loop 拾取

所有调用都必须使用 rr-chat 的结构化 MCP 工具。`
}

