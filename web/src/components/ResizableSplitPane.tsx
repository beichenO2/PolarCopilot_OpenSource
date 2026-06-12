import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { clsx } from 'clsx'

interface Props {
  left: ReactNode
  right: ReactNode
  defaultRatio?: number
  minLeftPx?: number
  minRightPx?: number
  collapseBreakpoint?: number
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  className?: string
}

export function ResizableSplitPane({
  left,
  right,
  defaultRatio = 0.35,
  minLeftPx = 220,
  minRightPx = 400,
  collapseBreakpoint = 900,
  collapsed: controlledCollapsed,
  onCollapsedChange,
  className,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const [dragging, setDragging] = useState(false)
  const [internalCollapsed, setInternalCollapsed] = useState(false)
  const [autoCollapsed, setAutoCollapsed] = useState(false)

  const collapsed = controlledCollapsed ?? internalCollapsed
  const setCollapsed = useCallback((v: boolean) => {
    onCollapsedChange ? onCollapsedChange(v) : setInternalCollapsed(v)
  }, [onCollapsedChange])

  useEffect(() => {
    const check = () => {
      if (!containerRef.current) return
      const w = containerRef.current.offsetWidth
      if (w < collapseBreakpoint && !collapsed && !autoCollapsed) {
        setAutoCollapsed(true)
        setCollapsed(true)
      } else if (w >= collapseBreakpoint && autoCollapsed) {
        setAutoCollapsed(false)
        setCollapsed(false)
      }
    }
    const ro = new ResizeObserver(check)
    if (containerRef.current) ro.observe(containerRef.current)
    check()
    return () => ro.disconnect()
  }, [collapseBreakpoint, collapsed, autoCollapsed, setCollapsed])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)

    const startX = e.clientX
    const startRatio = ratio
    const container = containerRef.current
    if (!container) return
    const containerWidth = container.offsetWidth

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      let newRatio = startRatio + dx / containerWidth
      const minRatio = minLeftPx / containerWidth
      const maxRatio = 1 - minRightPx / containerWidth
      newRatio = Math.max(minRatio, Math.min(maxRatio, newRatio))
      setRatio(newRatio)
    }

    const onUp = () => {
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [ratio, minLeftPx, minRightPx])

  const handleDoubleClick = useCallback(() => {
    setRatio(defaultRatio)
  }, [defaultRatio])

  return (
    <div ref={containerRef} className={clsx('flex h-full relative', className)}>
      {!collapsed && (
        <>
          <div
            className="overflow-y-auto overflow-x-hidden flex-shrink-0"
            style={{ width: `${ratio * 100}%` }}
          >
            {left}
          </div>

          <div
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            className={clsx(
              'w-[5px] flex-shrink-0 cursor-col-resize relative group transition-colors',
              dragging ? 'bg-hub-accent' : 'bg-hub-border hover:bg-hub-accent/60',
            )}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
            <div className={clsx(
              'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full transition-opacity',
              dragging ? 'bg-hub-accent opacity-100' : 'bg-hub-text-muted/40 opacity-0 group-hover:opacity-100',
            )} />
          </div>
        </>
      )}

      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="flex items-center">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={clsx(
              'flex-shrink-0 w-7 h-7 flex items-center justify-center rounded transition-colors text-xs',
              collapsed
                ? 'text-hub-accent hover:bg-hub-accent/10 ml-1 mt-1'
                : 'text-hub-text-muted hover:text-hub-accent absolute top-1 left-1 z-10',
            )}
            title={collapsed ? '展开 SSoT 侧边栏' : '折叠 SSoT 侧边栏'}
          >
            {collapsed ? '▶' : '◀'}
          </button>
        </div>
        {right}
      </div>
    </div>
  )
}
