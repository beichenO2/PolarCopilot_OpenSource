import { useState, useCallback, useRef } from 'react'

/**
 * 侧边栏拖拽调宽 — 宽度 localStorage 持久化，双击重置默认。
 * invert=true 用于分隔条在面板左缘的右侧栏（向左拖=变宽）。
 */
export function useResizableWidth(
  storageKey: string,
  defaultWidth: number,
  min: number,
  max: number,
  invert = false,
) {
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey))
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved
    } catch { /* storage 不可用则用默认 */ }
    return defaultWidth
  })
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startW = widthRef.current
    const dir = invert ? -1 : 1
    let latest = startW

    const onMove = (ev: MouseEvent) => {
      latest = Math.max(min, Math.min(max, startW + dir * (ev.clientX - startX)))
      setWidth(latest)
    }
    const onUp = () => {
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try { localStorage.setItem(storageKey, String(latest)) } catch { /* 忽略 */ }
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [storageKey, min, max, invert])

  const reset = useCallback(() => {
    setWidth(defaultWidth)
    try { localStorage.removeItem(storageKey) } catch { /* 忽略 */ }
  }, [storageKey, defaultWidth])

  return { width, dragging, onMouseDown, reset }
}
