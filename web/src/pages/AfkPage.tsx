import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { createAfkVnextTask, fetchAfkVnextTasks, fetchCompletion, taskCardModel } from '../lib/afk-vnext'

type Row = {
  task_id: string
  goal: string
  project_root: string
  surface: string
  status: string
  mode: string
  updated_at: string
}

export function AfkPage() {
  const [tasks, setTasks] = useState<Row[]>([])
  const [activeCount, setActiveCount] = useState(0)
  const [hint, setHint] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [gate, setGate] = useState<string>('')

  const refresh = useCallback(async () => {
    try {
      const data = await fetchAfkVnextTasks()
      setTasks((data.tasks as Row[]) ?? [])
      setActiveCount((data.active as unknown[])?.length ?? 0)
      setHint(data.exec_concurrency_hint ?? 1)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => clearInterval(t)
  }, [refresh])

  async function onCreate() {
    if (!goal.trim() || !projectRoot.trim()) return
    await createAfkVnextTask({ goal: goal.trim(), projectRoot: projectRoot.trim(), mode: 'solo' })
    setGoal('')
    await refresh()
  }

  async function onGate(taskId: string) {
    setSelected(taskId)
    const r = await fetchCompletion(taskId)
    setGate(
      r.gate_ok
        ? `PASS ${r.required_pass}/${r.required_total}`
        : `BLOCKED gaps=${JSON.stringify(r.gaps).slice(0, 400)}`,
    )
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6 text-slate-100">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">AFK Tasks</h1>
        <p className="text-sm text-slate-400">
          Control plane: SQLite status · surfaces ide/web · no sessionId in the primary view.
          Legacy Rr panel: <Link className="underline" to="/rr">/pc/rr</Link> (compat / diagnostics).
        </p>
        <p className="text-xs text-slate-500">
          Active {activeCount} · exec concurrency hint {hint} (Budget down ⇒ 1)
        </p>
      </header>

      {error && <div className="rounded border border-rose-700/50 bg-rose-950/40 p-3 text-sm">{error}</div>}

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Create (Web)</h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            placeholder="Goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <input
            className="flex-1 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            placeholder="Project root"
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium hover:bg-emerald-600"
            onClick={() => void onCreate()}
          >
            Queue task
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium uppercase tracking-wide text-slate-400">Tasks</h2>
        <ul className="divide-y divide-slate-800 rounded border border-slate-800">
          {tasks.length === 0 && (
            <li className="p-4 text-sm text-slate-500">No vNext tasks yet.</li>
          )}
          {tasks.map((t) => {
            const card = taskCardModel(t)
            return (
              <li key={card.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="font-medium">{card.goal || card.id}</div>
                  <div className="text-xs text-slate-500">
                    {card.phase} · {card.surface} · {card.id}
                  </div>
                </div>
                <button
                  type="button"
                  className="rounded border border-slate-600 px-3 py-1 text-xs hover:bg-slate-800"
                  onClick={() => void onGate(card.id)}
                >
                  Completion gate
                </button>
              </li>
            )
          })}
        </ul>
        {selected && (
          <pre className="overflow-auto rounded bg-slate-950 p-3 text-xs text-slate-300">{gate}</pre>
        )}
      </section>
    </div>
  )
}
