import type { Prompt, PromptOption } from '../types/hub'
import { optionLabel } from '../types/hub'

export type ThreadAttachment = {
  kind: 'html' | 'image' | 'pdf' | 'file'
  href: string
  title?: string
}

export type ThreadMessage = {
  id: string
  prompt_id: string
  role: 'agent' | 'user' | 'pending'
  text: string
  created_at: string
  options?: string[]
  attachments: ThreadAttachment[]
}

export type ThreadResponse = {
  agent_id: string
  messages: ThreadMessage[]
}

const ATTACHMENT_RE =
  /(?:https?:\/\/[^\s<>"')]+|(?:@ppppolarrrrr:)?\/?[\w./~%-]+)\.(?:html|png|jpg|jpeg|webp|gif|pdf)\b/gi

function attachmentKind(ext: string): ThreadAttachment['kind'] {
  const lower = ext.toLowerCase()
  if (lower === '.html') return 'html'
  if (lower === '.pdf') return 'pdf'
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(lower)) return 'image'
  return 'file'
}

function normalizeHref(raw: string): string {
  return raw.startsWith('@ppppolarrrrr:') ? raw.slice('@ppppolarrrrr:'.length) : raw
}

export function extractAttachments(text: string): ThreadAttachment[] {
  const seen = new Set<string>()
  const attachments: ThreadAttachment[] = []

  for (const match of text.matchAll(ATTACHMENT_RE)) {
    const href = normalizeHref(match[0])
    if (seen.has(href)) continue
    seen.add(href)

    const dot = href.lastIndexOf('.')
    const ext = dot >= 0 ? href.slice(dot) : ''
    const title = href.split('/').pop()

    attachments.push({
      kind: attachmentKind(ext),
      href,
      ...(title ? { title } : {}),
    })
  }

  return attachments
}

function mapOptions(options: PromptOption[]): string[] {
  return options.map(optionLabel)
}

function buildMessagesFromPrompts(prompts: Prompt[]): ThreadMessage[] {
  const sorted = [...prompts].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const messages: ThreadMessage[] = []

  for (const prompt of sorted) {
    const options = prompt.options?.length ? mapOptions(prompt.options) : undefined

    messages.push({
      id: `${prompt.id}:agent`,
      prompt_id: prompt.id,
      role: 'agent',
      text: prompt.prompt,
      created_at: prompt.created_at,
      ...(options ? { options } : {}),
      attachments: extractAttachments(prompt.prompt),
    })

    if (prompt.answered) {
      messages.push({
        id: `${prompt.id}:user`,
        prompt_id: prompt.id,
        role: 'user',
        text: prompt.answer ?? '',
        created_at: prompt.answered_at ?? prompt.created_at,
        attachments: [],
      })
    } else {
      messages.push({
        id: `${prompt.id}:pending`,
        prompt_id: prompt.id,
        role: 'pending',
        text: '待你答',
        created_at: prompt.created_at,
        ...(options ? { options } : {}),
        attachments: [],
      })
    }
  }

  return messages
}

export function assembleThread(agentId: string, prompts: Prompt[]): ThreadResponse {
  const filtered = prompts.filter((p) => p.agent_id === agentId)
  return { agent_id: agentId, messages: buildMessagesFromPrompts(filtered) }
}

export function shouldRenderAgentBubble(messages: ThreadMessage[], msg: ThreadMessage): boolean {
  if (msg.role !== 'agent') return false
  return !messages.some((m) => m.role === 'pending' && m.prompt_id === msg.prompt_id)
}

/** True when scroll container bottom gap is within threshold (default 100px). */
export function isAtLiveEdge(scrollBottomGapPx: number, thresholdPx = 100): boolean {
  return scrollBottomGapPx <= thresholdPx
}

/** Last pending message prompt_id for scroll target; null when none. */
export function pendingScrollTargetId(messages: ThreadMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'pending') return messages[i].prompt_id
  }
  return null
}

export function buildCenterThread(
  agentId: string | null,
  pending: Prompt[],
  history: Prompt[],
): ThreadResponse {
  const byId = new Map<string, Prompt>()
  for (const p of history) {
    byId.set(p.id, p)
  }
  for (const p of pending) {
    byId.set(p.id, p)
  }
  const merged = Array.from(byId.values())

  if (agentId) {
    return assembleThread(agentId, merged)
  }

  return { agent_id: '*', messages: buildMessagesFromPrompts(merged) }
}
