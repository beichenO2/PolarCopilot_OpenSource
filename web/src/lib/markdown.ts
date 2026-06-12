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

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  const withRefs = renderSsotRefs(raw)
  return DOMPurify.sanitize(withRefs, { ADD_ATTR: ['class', 'title', 'role', 'tabindex', 'data-ssot-project', 'data-ssot-req', 'data-ssot-feature'] })
}
