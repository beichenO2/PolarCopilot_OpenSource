import { marked } from 'marked'
import DOMPurify from 'dompurify'

marked.setOptions({
  breaks: true,
  gfm: true,
})

const SSOT_REF_RE = /\[SSoT:([^\]]+)\]\s*([^\n]*)/g

function renderSsotRefs(html: string): string {
  return html.replace(SSOT_REF_RE, (_match, ref: string, label: string) => {
    const parts = ref.split('/')
    const project = parts[0] ?? ''
    const reqId = parts[1] ?? ''
    const feature = parts.slice(2).join('/') || ''
    const display = label.trim() || ref
    return `<span class="ssot-ref" role="button" tabindex="0" data-ssot-project="${project}" data-ssot-req="${reqId}" data-ssot-feature="${feature}" title="点击跳转到 SSoT: ${ref}">${display}</span>`
  })
}

/* ── Prompt 配图哨兵 ─────────────────────────────────────────────
 * Agent 在正文写（@ppppolarrrrr:/绝对路径.png）（全角/半角括号均可，
 * 路径无空格时可省括号）→ 替换为 <img>，经 Hub /api/ui/local-image 只读服务。
 * 鲁棒原则：不是绝对路径 / 不是图片扩展名 → 不解析，原样保留；绝不抛错。
 */
const IMAGE_SENTINEL = '@ppppolarrrrr:'
const IMAGE_SENTINEL_RE = /[（(]\s*@ppppolarrrrr:([^）)\n]+?)\s*[）)]|@ppppolarrrrr:([^\s）)]+)/g
const IMAGE_EXT_WHITELIST = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function imageExtOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot).toLowerCase() : ''
}

export function renderImageSentinels(text: string): string {
  if (!text.includes(IMAGE_SENTINEL)) return text
  return text.replace(IMAGE_SENTINEL_RE, (match, wrapped?: string, bare?: string) => {
    const candidate = (wrapped ?? bare ?? '').trim().replace(/^["']|["']$/g, '')
    // 严格校验：绝对路径 + 图片扩展名白名单；不满足 → 原样保留，不硬解析
    if (!candidate.startsWith('/') || !IMAGE_EXT_WHITELIST.has(imageExtOf(candidate))) {
      return match
    }
    const src = `/api/ui/local-image?path=${encodeURIComponent(candidate)}`
    const name = candidate.split('/').pop() ?? candidate
    return `<a href="${src}" target="_blank" rel="noopener"><img class="pc-inline-image" src="${src}" alt="${escapeAttr(name)}" title="${escapeAttr(candidate)}" loading="lazy"></a>`
  })
}

export function renderMarkdown(text: string): string {
  const withImages = renderImageSentinels(text)
  const raw = marked.parse(withImages, { async: false }) as string
  const withRefs = renderSsotRefs(raw)
  return DOMPurify.sanitize(withRefs, { ADD_ATTR: ['class', 'title', 'role', 'tabindex', 'loading', 'target', 'data-ssot-project', 'data-ssot-req', 'data-ssot-feature'] })
}
