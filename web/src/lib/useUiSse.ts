import { useEffect, useRef } from 'react'

type UiSseEvent = {
  type: string
  data: Record<string, unknown>
}

export function useUiSse(onEvent: (event: UiSseEvent) => void): void {
  const cbRef = useRef(onEvent)
  cbRef.current = onEvent

  useEffect(() => {
    const base = (import.meta as unknown as Record<string, Record<string, string>>).env?.VITE_HUB_URL ?? ''
    const es = new EventSource(`${base}/api/ui/stream`)

    const handler = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data)
        cbRef.current({ type: ev.type, data })
      } catch { /* ignore malformed events */ }
    }

    es.onerror = () => {
      console.warn('[useUiSse] connection lost, browser will auto-reconnect')
    }

    const events = [
      'prompt_created', 'prompt_answered',
      'alignment_created', 'alignment_updated',
      'ssot_updated',
      'prolusion_created', 'prolusion_updated', 'prolusion_dispatched', 'prolusion_deleted',
    ] as const
    for (const evt of events) es.addEventListener(evt, handler)

    return () => {
      for (const evt of events) es.removeEventListener(evt, handler)
      es.close()
    }
  }, [])
}
