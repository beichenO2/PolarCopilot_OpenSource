import { useEffect } from 'react'

export type UiSseHandler = (event: string, data: Record<string, unknown>) => void

export function useUiSse(onEvent: UiSseHandler): void {
  useEffect(() => {
    const es = new EventSource('/api/ui/stream')

    const wrap = (type: string) => (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as Record<string, unknown>
        onEvent(type, data)
      } catch { /* ignore */ }
    }

    es.addEventListener('prompt_created', wrap('prompt_created'))
    es.addEventListener('prompt_answered', wrap('prompt_answered'))
    es.addEventListener('alignment_updated', wrap('alignment_updated'))

    es.onerror = () => {
      console.warn('[useUiSse] connection lost, browser will auto-reconnect')
    }

    return () => es.close()
  }, [onEvent])
}
