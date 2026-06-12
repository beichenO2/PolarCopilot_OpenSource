import { useEffect, useState, useCallback } from 'react'
import { clsx } from 'clsx'

interface BranchInfo {
  name: string
  date: string
  message: string
}

type MergeStatus = 'idle' | 'merging' | 'success' | 'conflict' | 'error'

export function MergePage() {
  const [branches, setBranches] = useState<BranchInfo[]>([])
  const [currentBranch, setCurrentBranch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [mergeStatus, setMergeStatus] = useState<MergeStatus>('idle')
  const [mergeLog, setMergeLog] = useState('')

  const fetchBranches = useCallback(async () => {
    try {
      const res = await fetch('/api/ui/merge/branches')
      if (!res.ok) throw new Error('fetch failed')
      const data = await res.json()
      setBranches(data.branches ?? [])
      setCurrentBranch(data.current_branch ?? '')
    } catch {
      setBranches([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchBranches() }, [fetchBranches])

  const handleMerge = async () => {
    if (!selected) return
    setMergeStatus('merging')
    setMergeLog('')
    try {
      const res = await fetch('/api/ui/merge/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: selected }),
      })
      const data = await res.json()
      if (data.ok) {
        setMergeStatus('success')
        setMergeLog(data.log ?? 'Merge successful')
        fetchBranches()
      } else if (data.conflict) {
        setMergeStatus('conflict')
        setMergeLog(data.log ?? 'Merge conflict detected')
      } else {
        setMergeStatus('error')
        setMergeLog(data.error ?? 'Unknown error')
      }
    } catch (err) {
      setMergeStatus('error')
      setMergeLog(String(err))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Branch Merge</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-zinc-400">
            Current: <span className="font-mono text-emerald-400">{currentBranch || '...'}</span>
          </span>
          <button onClick={fetchBranches} className="rounded bg-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-600">
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-zinc-400">Loading branches...</div>
      ) : branches.length === 0 ? (
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/50 p-8 text-center text-zinc-400">
          No agent/* branches found. Main Agent merges appear here.
        </div>
      ) : (
        <div className="space-y-2">
          {branches.map((b) => (
            <button
              key={b.name}
              onClick={() => setSelected(b.name === selected ? null : b.name)}
              className={clsx(
                'w-full rounded-lg border p-4 text-left transition',
                b.name === selected
                  ? 'border-blue-500 bg-blue-500/10'
                  : 'border-zinc-700 bg-zinc-800/50 hover:border-zinc-500',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-white">{b.name}</span>
                <span className="text-xs text-zinc-500">{b.date ? new Date(b.date).toLocaleString() : ''}</span>
              </div>
              {b.message && <p className="mt-1 text-sm text-zinc-400">{b.message}</p>}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleMerge}
            disabled={mergeStatus === 'merging'}
            className={clsx(
              'rounded-lg px-4 py-2 font-medium text-white transition',
              mergeStatus === 'merging' ? 'cursor-wait bg-zinc-600' : 'bg-blue-600 hover:bg-blue-500',
            )}
          >
            {mergeStatus === 'merging' ? 'Merging...' : `Merge ${selected} → ${currentBranch}`}
          </button>
        </div>
      )}

      {mergeStatus !== 'idle' && mergeStatus !== 'merging' && (
        <div
          className={clsx(
            'rounded-lg border p-4',
            mergeStatus === 'success' && 'border-emerald-700 bg-emerald-900/20 text-emerald-300',
            mergeStatus === 'conflict' && 'border-yellow-700 bg-yellow-900/20 text-yellow-300',
            mergeStatus === 'error' && 'border-red-700 bg-red-900/20 text-red-300',
          )}
        >
          <p className="mb-2 font-medium">
            {mergeStatus === 'success' && 'Merge Successful'}
            {mergeStatus === 'conflict' && 'Merge Conflict'}
            {mergeStatus === 'error' && 'Merge Failed'}
          </p>
          <pre className="whitespace-pre-wrap font-mono text-xs">{mergeLog}</pre>
        </div>
      )}
    </div>
  )
}
