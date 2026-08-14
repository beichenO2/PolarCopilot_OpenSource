import { useEffect, useState } from 'react'
import { DESIGN_TOPIC_ID, topicHtmlApiPath } from '../lib/topic-html'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'ready'; html: string }

type TopicHtmlViewerProps = {
  agentId?: string | null
}

export function TopicHtmlViewer({ agentId }: TopicHtmlViewerProps = {}) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const resp = await fetch(topicHtmlApiPath(DESIGN_TOPIC_ID, agentId))
        if (cancelled) return
        if (!resp.ok) {
          setState({ kind: 'empty' })
          return
        }
        const html = await resp.text()
        if (cancelled) return
        setState({ kind: 'ready', html })
      } catch {
        if (!cancelled) setState({ kind: 'empty' })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [agentId])

  return (
    <div className="px-2 mb-3">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[0.65rem] text-zinc-400 font-medium">设计页</span>
        <span className="text-[0.55rem] text-zinc-600 font-mono">_design/index.html</span>
      </div>

      {state.kind === 'loading' && (
        <div className="h-[280px] w-full rounded-lg border border-zinc-800 bg-zinc-900/40 flex items-center justify-center">
          <span className="text-[0.65rem] text-zinc-600">加载中…</span>
        </div>
      )}

      {state.kind === 'empty' && (
        <div className="h-[280px] w-full rounded-lg border border-zinc-800 bg-zinc-900/40 flex items-center justify-center">
          <span className="text-[0.65rem] text-zinc-500">尚无设计页</span>
        </div>
      )}

      {state.kind === 'ready' && (
        <iframe
          title="设计页预览"
          srcDoc={state.html}
          sandbox="allow-scripts allow-same-origin"
          className="h-[280px] w-full rounded-lg border border-zinc-800 bg-zinc-950"
        />
      )}
    </div>
  )
}
