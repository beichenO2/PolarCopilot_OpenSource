import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import type { EvolutionSuggestion, EvolutionGene, EvolutionSignal, EvolutionStats } from '../lib/api'
import { renderMarkdown } from '../lib/markdown'

type TabId = 'pending' | 'history' | 'genes' | 'signals'

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40',
  approved: 'bg-green-500/20 text-green-400 border-green-500/40',
  rejected: 'bg-red-500/20 text-red-400 border-red-500/40',
  executing: 'bg-blue-500/20 text-blue-400 border-blue-500/40',
  done: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40',
  failed: 'bg-red-600/20 text-red-500 border-red-600/40',
}

const CATEGORY_STYLES: Record<string, string> = {
  repair: 'bg-orange-500/20 text-orange-400',
  optimize: 'bg-blue-500/20 text-blue-400',
  innovate: 'bg-purple-500/20 text-purple-400',
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full border ${STATUS_STYLES[status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/40'}`}>
      {status}
    </span>
  )
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full ${CATEGORY_STYLES[category] ?? 'bg-gray-500/20 text-gray-400'}`}>
      {category}
    </span>
  )
}

function SuggestionCard({
  s,
  onApprove,
  onReject,
}: {
  s: EvolutionSuggestion
  onApprove: (id: string) => void
  onReject: (id: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  const [showRejectInput, setShowRejectInput] = useState(false)

  return (
    <div className="border border-hub-border rounded-lg bg-hub-surface p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <StatusBadge status={s.status} />
            <span className="text-xs text-hub-text-muted">
              {s.blastRadius.files} files / {s.blastRadius.lines} lines
            </span>
          </div>
          <h3 className="text-sm font-medium text-hub-text">{s.title}</h3>
          <p className="text-xs text-hub-text-muted mt-1">Gene: {s.geneId}</p>
        </div>
        {s.status === 'pending' && (
          <div className="flex gap-2 shrink-0">
            <button
              onClick={() => onApprove(s.id)}
              className="px-3 py-1.5 text-xs rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => setShowRejectInput(!showRejectInput)}
              className="px-3 py-1.5 text-xs rounded-md bg-red-600/80 hover:bg-red-500 text-white transition-colors"
            >
              Reject
            </button>
          </div>
        )}
      </div>

      {showRejectInput && s.status === 'pending' && (
        <div className="flex gap-2">
          <input
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="Reason for rejection..."
            className="flex-1 px-3 py-1.5 text-sm bg-hub-bg border border-hub-border rounded-md text-hub-text placeholder:text-hub-text-muted"
          />
          <button
            onClick={() => { onReject(s.id); setShowRejectInput(false) }}
            className="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white"
          >
            Confirm Reject
          </button>
        </div>
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-hub-accent hover:underline"
      >
        {expanded ? 'Collapse' : 'Show Details'}
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-hub-border pt-3">
          <div>
            <h4 className="text-xs font-medium text-hub-text-muted mb-1">Analysis</h4>
            <div className="text-sm text-hub-text prose-sm prose-invert max-w-none"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(s.analysis) }} />
          </div>
          <div>
            <h4 className="text-xs font-medium text-hub-text-muted mb-1">Proposed Change</h4>
            <div className="text-sm text-hub-text prose-sm prose-invert max-w-none whitespace-pre-wrap"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(s.proposedChange) }} />
          </div>
          {s.rejectReason && (
            <div>
              <h4 className="text-xs font-medium text-red-400 mb-1">Reject Reason</h4>
              <p className="text-sm text-hub-text">{s.rejectReason}</p>
            </div>
          )}
          <div className="text-xs text-hub-text-muted">
            Created: {new Date(s.createdAt).toLocaleString()}
            {s.resolvedAt && ` | Resolved: ${new Date(s.resolvedAt).toLocaleString()} by ${s.resolvedBy}`}
          </div>
        </div>
      )}
    </div>
  )
}

function GeneCard({ gene }: { gene: EvolutionGene }) {
  const [expanded, setExpanded] = useState(false)
  const total = gene.successCount + gene.failureCount
  const rate = total > 0 ? Math.round((gene.successCount / total) * 100) : null

  return (
    <div className="border border-hub-border rounded-lg bg-hub-surface p-4 space-y-2">
      <div className="flex items-center gap-2">
        <CategoryBadge category={gene.category} />
        <h3 className="text-sm font-medium text-hub-text flex-1">{gene.title}</h3>
        {rate !== null && (
          <span className="text-xs text-hub-text-muted">{rate}% success ({total} runs)</span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {gene.signalsMatch.map((s) => (
          <span key={s} className="px-2 py-0.5 text-xs rounded-full bg-hub-bg text-hub-text-muted border border-hub-border">
            {s}
          </span>
        ))}
      </div>
      <button onClick={() => setExpanded(!expanded)} className="text-xs text-hub-accent hover:underline">
        {expanded ? 'Collapse' : 'Show Strategy'}
      </button>
      {expanded && (
        <div className="border-t border-hub-border pt-2 space-y-2">
          <div>
            <h4 className="text-xs font-medium text-hub-text-muted mb-1">Strategy</h4>
            <ol className="list-decimal list-inside text-sm text-hub-text space-y-1">
              {gene.strategy.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>
          {gene.validation.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-hub-text-muted mb-1">Validation</h4>
              <ul className="list-disc list-inside text-sm text-hub-text space-y-1">
                {gene.validation.map((v, i) => <li key={i} className="font-mono text-xs">{v}</li>)}
              </ul>
            </div>
          )}
          <p className="text-xs text-hub-text-muted">ID: {gene.id}</p>
        </div>
      )}
    </div>
  )
}

function SignalRow({ signal }: { signal: EvolutionSignal }) {
  return (
    <tr className="border-b border-hub-border hover:bg-hub-surface/50">
      <td className="py-2 px-3 text-xs text-hub-text-muted">{new Date(signal.createdAt).toLocaleString()}</td>
      <td className="py-2 px-3">
        <span className="px-2 py-0.5 text-xs rounded-full bg-hub-bg text-hub-text-muted border border-hub-border">{signal.type}</span>
      </td>
      <td className="py-2 px-3 text-sm text-hub-text">{signal.title}</td>
      <td className="py-2 px-3 text-xs text-hub-text-muted">{signal.source}</td>
    </tr>
  )
}

function StatsBar({ stats }: { stats: EvolutionStats | null }) {
  if (!stats) return null
  return (
    <div className="flex gap-4 text-xs text-hub-text-muted border-b border-hub-border pb-3">
      <span>Signals: <strong className="text-hub-text">{stats.signals.total}</strong></span>
      <span>Genes: <strong className="text-hub-text">{stats.genes.total}</strong></span>
      <span>Pending: <strong className="text-yellow-400">{stats.suggestions.pending}</strong></span>
      <span>Approved: <strong className="text-green-400">{stats.suggestions.approved}</strong></span>
      <span>Done: <strong className="text-emerald-400">{stats.suggestions.done}</strong></span>
    </div>
  )
}

export function EvolutionPage() {
  const [tab, setTab] = useState<TabId>('pending')
  const [suggestions, setSuggestions] = useState<EvolutionSuggestion[]>([])
  const [genes, setGenes] = useState<EvolutionGene[]>([])
  const [signals, setSignals] = useState<EvolutionSignal[]>([])
  const [stats, setStats] = useState<EvolutionStats | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [st, sg] = await Promise.all([
        api.evolution.stats(),
        tab === 'pending' ? api.evolution.suggestions('pending') :
          tab === 'history' ? api.evolution.suggestions() :
            tab === 'genes' ? api.evolution.genes() :
              api.evolution.signals({ limit: 100 }),
      ])
      setStats(st)
      if (tab === 'pending' || tab === 'history') setSuggestions(sg as EvolutionSuggestion[])
      if (tab === 'genes') setGenes(sg as EvolutionGene[])
      if (tab === 'signals') setSignals(sg as EvolutionSignal[])
    } catch (err) {
      console.error('evolution fetch error', err)
    } finally {
      setLoading(false)
    }
  }, [tab])

  useUiSse(useCallback(() => { refresh() }, [refresh]))

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => {
    const id = setInterval(refresh, 15000)
    return () => clearInterval(id)
  }, [refresh])

  const handleApprove = async (id: string) => {
    await api.evolution.approveSuggestion(id)
    refresh()
  }

  const handleReject = async (id: string) => {
    await api.evolution.rejectSuggestion(id, '')
    refresh()
  }

  const tabs: { id: TabId; label: string; count?: number }[] = [
    { id: 'pending', label: 'Pending', count: stats?.suggestions.pending },
    { id: 'history', label: 'History' },
    { id: 'genes', label: 'Genes', count: stats?.genes.total },
    { id: 'signals', label: 'Signals', count: stats?.signals.total },
  ]

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-hub-text">Evolution</h2>
        <button onClick={refresh} disabled={loading}
          className="px-3 py-1.5 text-xs rounded-md border border-hub-border text-hub-text-muted hover:text-hub-accent hover:border-hub-accent transition-colors disabled:opacity-50">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <StatsBar stats={stats} />

      <div className="flex gap-1 border-b border-hub-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm border-b-2 transition-colors ${
              tab === t.id
                ? 'border-hub-accent text-hub-accent'
                : 'border-transparent text-hub-text-muted hover:text-hub-text'
            }`}
          >
            {t.label}
            {t.count != null && t.count > 0 && (
              <span className="ml-1.5 px-1.5 py-0.5 text-xs rounded-full bg-hub-border">{t.count}</span>
            )}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {tab === 'pending' && (
          suggestions.length === 0
            ? <p className="text-sm text-hub-text-muted py-8 text-center">No pending suggestions</p>
            : suggestions.map((s) => (
              <SuggestionCard key={s.id} s={s} onApprove={handleApprove} onReject={handleReject} />
            ))
        )}

        {tab === 'history' && (
          suggestions.length === 0
            ? <p className="text-sm text-hub-text-muted py-8 text-center">No suggestions yet</p>
            : suggestions.map((s) => (
              <SuggestionCard key={s.id} s={s} onApprove={handleApprove} onReject={handleReject} />
            ))
        )}

        {tab === 'genes' && (
          genes.length === 0
            ? <p className="text-sm text-hub-text-muted py-8 text-center">No genes loaded</p>
            : genes.map((g) => <GeneCard key={g.id} gene={g} />)
        )}

        {tab === 'signals' && (
          signals.length === 0
            ? <p className="text-sm text-hub-text-muted py-8 text-center">No signals collected yet</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-hub-border text-xs text-hub-text-muted">
                      <th className="py-2 px-3 font-medium">Time</th>
                      <th className="py-2 px-3 font-medium">Type</th>
                      <th className="py-2 px-3 font-medium">Title</th>
                      <th className="py-2 px-3 font-medium">Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((s) => <SignalRow key={s.id} signal={s} />)}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </div>
  )
}
