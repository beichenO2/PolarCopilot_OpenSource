import type { ReactNode } from 'react'
import { clsx } from 'clsx'

interface Props {
  title?: string
  count: number
  show: boolean
  onToggleShow: () => void
  storageKey: string
  children: ReactNode
  emptyText?: string
}

/** Right-side history column header + body (width controlled by parent ResizableSplitPane). */
export function HistoryPanel({
  title = 'History',
  count,
  show,
  onToggleShow,
  storageKey,
  children,
  emptyText = 'No history yet',
}: Props) {
  return (
    <aside
      className="h-full flex flex-col border-l border-hub-border px-3 py-4"
      data-storage-key={storageKey}
    >
      <div className="flex items-center gap-3 mb-3 pb-2 border-b border-hub-border flex-shrink-0">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          {title}
          <span className="text-[0.65rem] px-1.5 py-0.5 rounded-lg bg-hub-border text-hub-text-muted">
            {count}
          </span>
        </h2>
        <button
          type="button"
          onClick={onToggleShow}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md border border-hub-border text-hub-text-muted text-[0.65rem] hover:border-hub-accent hover:text-hub-text transition-colors select-none"
        >
          <span className={clsx('inline-block transition-transform', show && 'rotate-180')}>▼</span>
          {show ? ' Hide' : ' Show'}
        </button>
      </div>
      <p className="text-[0.6rem] text-hub-text-muted mb-2 flex-shrink-0">
        拖拽左侧分隔条调整宽度 · 双击分隔条恢复默认 · 比例保存在 localStorage（{storageKey}）
      </p>
      {show ? (
        <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
          {count > 0 ? children : (
            <p className="text-[0.75rem] text-hub-text-muted italic text-center py-4">{emptyText}</p>
          )}
        </div>
      ) : null}
    </aside>
  )
}
