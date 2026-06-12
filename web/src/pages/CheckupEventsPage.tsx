import { Fragment, useCallback, useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { api } from '../lib/api'
import { timeAgo } from '../lib/time'

type CheckupStatus = 'pending' | 'processing' | 'resolved' | 'needs_human'

interface CheckupRow {
  event_id: string
  project: string
  page_url: string
  user_text: string
  timestamp: string
  received_at?: string
  status: CheckupStatus
  summary?: string
  handler?: string
}

interface CheckupListResponse {
  ok: boolean
  count: number
  stats: Record<CheckupStatus, number>
  events: CheckupRow[]
}

const STATUS_LABEL: Record<CheckupStatus, string> = {
  pending: '待处理',
  processing: '处理中',
  resolved: '已解决',
  needs_human: '需人工',
}

const STATUS_CLASS: Record<CheckupStatus, string> = {
  pending: 'border-hub-yellow text-hub-yellow bg-hub-yellow/10',
  processing: 'border-hub-accent text-hub-accent bg-hub-accent/10',
  resolved: 'border-hub-green text-hub-green bg-hub-green/10',
  needs_human: 'border-hub-red text-hub-red bg-hub-red/10',
}

export function CheckupEventsPage() {
  const [data, setData] = useState<CheckupListResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.checkup.list(100)
      setData(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const iv = setInterval(refresh, 15000)
    return () => clearInterval(iv)
  }, [refresh])

  const stats = data?.stats ?? { pending: 0, processing: 0, resolved: 0, needs_human: 0 }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-xl font-semibold text-hub-text">检修事件历史</h2>
          <p className="text-sm text-hub-text-muted mt-1">
            全生态 Widget 提交 → <code className="text-hub-accent">@checkup-agent</code> → PolarUI 工作流
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="ml-auto px-3 py-1.5 text-xs rounded-md border border-hub-border bg-hub-surface hover:border-hub-accent"
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <p className="text-hub-red text-sm">{error}</p>}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(Object.keys(STATUS_LABEL) as CheckupStatus[]).map((key) => (
          <div key={key} className={clsx('rounded-lg border px-4 py-3', STATUS_CLASS[key])}>
            <div className="text-xs opacity-80">{STATUS_LABEL[key]}</div>
            <div className="text-2xl font-semibold mt-1">{stats[key] ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="border border-hub-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-hub-surface border-b border-hub-border text-hub-text-muted">
            <tr>
              <th className="text-left px-4 py-2">状态</th>
              <th className="text-left px-4 py-2">项目</th>
              <th className="text-left px-4 py-2">描述</th>
              <th className="text-left px-4 py-2">时间</th>
            </tr>
          </thead>
          <tbody>
            {(data?.events ?? []).map((row) => (
              <Fragment key={row.event_id}>
                <tr
                  className="border-b border-hub-border/60 hover:bg-hub-surface/50 cursor-pointer"
                  onClick={() => setExpanded(expanded === row.event_id ? null : row.event_id)}
                >
                  <td className="px-4 py-3">
                    <span className={clsx('inline-block px-2 py-0.5 rounded border text-xs', STATUS_CLASS[row.status])}>
                      {STATUS_LABEL[row.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">{row.project}</td>
                  <td className="px-4 py-3 max-w-md truncate">{row.user_text}</td>
                  <td className="px-4 py-3 text-hub-text-muted whitespace-nowrap">
                    {timeAgo(row.received_at ?? row.timestamp)}
                  </td>
                </tr>
                {expanded === row.event_id && (
                  <tr className="bg-hub-surface/30">
                    <td colSpan={4} className="px-4 py-3 text-xs space-y-2">
                      <div><strong>event_id:</strong> {row.event_id}</div>
                      <div><strong>page_url:</strong>{' '}
                        <a href={row.page_url} className="text-hub-accent hover:underline" target="_blank" rel="noreferrer">
                          {row.page_url}
                        </a>
                      </div>
                      {row.summary && <div><strong>处理摘要:</strong> {row.summary}</div>}
                      {row.handler && <div><strong>handler:</strong> {row.handler}</div>}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!loading && !(data?.events?.length) && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-hub-text-muted">
                  暂无检修事件（可在任意嵌入 Widget 的页面提交）
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
