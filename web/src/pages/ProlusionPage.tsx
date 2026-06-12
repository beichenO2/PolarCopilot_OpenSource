import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import type {
  ProlusionPlanSummary,
  ProlusionPlan,
  ProlusionDemandAnalysis,
  ProlusionCodeMapping,
  ProlusionTechOverview,
  ProlusionTaskItem,
} from '../lib/api'

const STAGES = [
  { num: 1, key: 'demand_analysis', label: '需求分析', icon: '🎯' },
  { num: 2, key: 'code_mapping', label: '代码映射', icon: '🗺️' },
  { num: 3, key: 'tech_overview', label: '技术概览', icon: '⚙️' },
  { num: 4, key: 'task_allocation', label: '任务分配', icon: '📦' },
] as const

const STATUS_COLORS: Record<string, string> = {
  stage_1: 'text-yellow-400',
  stage_2: 'text-blue-400',
  stage_3: 'text-purple-400',
  stage_4: 'text-orange-400',
  completed: 'text-emerald-400',
  dispatched: 'text-green-400',
}

function StatusBadge({ status }: { status: string }) {
  const label = status.startsWith('stage_')
    ? `阶段 ${status.slice(6)}`
    : status === 'completed' ? '已完成' : status === 'dispatched' ? '已派发' : status
  return (
    <span className={`text-sm font-medium ${STATUS_COLORS[status] ?? 'text-gray-400'}`}>
      {label}
    </span>
  )
}

function StageProgress({
  current, viewing, total = 4, onSelect,
}: { current: number; viewing?: number; total?: number; onSelect?: (stage: number) => void }) {
  return (
    <div className="flex items-center gap-1">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center">
          <button
            type="button"
            onClick={() => onSelect?.(i + 1)}
            className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors ${
              onSelect ? 'cursor-pointer hover:scale-110' : ''
            } ${
              viewing === i + 1
                ? 'ring-2 ring-hub-accent ring-offset-2 ring-offset-hub-bg'
                : ''
            } ${
              i + 1 < current ? 'bg-emerald-500/30 border-emerald-500 text-emerald-300'
              : i + 1 === current ? 'bg-hub-accent/20 border-hub-accent text-hub-accent'
              : 'bg-hub-surface border-hub-border text-hub-text-muted'
            }`}
          >
            {i + 1 < current ? '✓' : i + 1}
          </button>
          {i < total - 1 && (
            <div className={`w-8 h-0.5 ${i + 1 < current ? 'bg-emerald-500' : 'bg-hub-border'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

function CreatePlanDialog({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!title.trim() || !goal.trim()) return
    setSubmitting(true)
    try {
      await api.prolusion.create({ title: title.trim(), goal: goal.trim(), created_by: 'user' })
      onCreated()
      onClose()
    } catch (e) {
      console.error(e)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="bg-hub-surface border border-hub-border rounded-xl p-6 w-[600px] max-w-[90vw]" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-[#e6edf3] mb-4">创建整体规划</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-hub-text-muted mb-1">规划标题</label>
            <input
              className="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text"
              placeholder="例：PolarCopilot v2.0 架构升级"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm text-hub-text-muted mb-1">高层目标</label>
            <textarea
              className="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text min-h-[120px] resize-y"
              placeholder="描述你想要达成的目标..."
              value={goal}
              onChange={e => setGoal(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-hub-text-muted hover:text-hub-text">取消</button>
          <button
            onClick={submit}
            disabled={submitting || !title.trim() || !goal.trim()}
            className="px-4 py-2 text-sm bg-hub-accent text-white rounded-lg hover:bg-hub-accent/80 disabled:opacity-50"
          >
            {submitting ? '创建中...' : '创建规划'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DemandAnalysisEditor({
  data, onChange,
}: { data: ProlusionDemandAnalysis; onChange: (d: ProlusionDemandAnalysis) => void }) {
  const addObjective = () => onChange({ ...data, objectives: [...(data.objectives ?? []), ''] })
  const addConstraint = () => onChange({ ...data, constraints: [...(data.constraints ?? []), ''] })
  const addCriteria = () => onChange({ ...data, success_criteria: [...(data.success_criteria ?? []), ''] })

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">目标分解</label>
          <button onClick={addObjective} className="text-xs text-hub-accent hover:underline">+ 添加</button>
        </div>
        {(data.objectives ?? []).map((obj, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input
              className="flex-1 bg-hub-bg border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
              value={obj}
              placeholder={[
                '例：实现 Agent 自动派发任务到空闲 Slave',
                '例：Hub Web UI 支持 Prolusion 全流程操作',
                '例：polaris.json SSoT 与 Agent 执行自动同步',
              ][i % 3]}
              onChange={e => {
                const next = [...(data.objectives ?? [])]
                next[i] = e.target.value
                onChange({ ...data, objectives: next })
              }}
            />
            <button onClick={() => {
              const next = (data.objectives ?? []).filter((_, j) => j !== i)
              onChange({ ...data, objectives: next })
            }} className="text-red-400 hover:text-red-300 text-sm px-1">✕</button>
          </div>
        ))}
      </div>
      <div>
        <label className="text-sm font-medium text-hub-text block mb-2">范围界定</label>
        <textarea
          className="w-full bg-hub-bg border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[80px] resize-y placeholder:text-hub-text-muted/40"
          value={data.scope ?? ''}
          placeholder="例：仅限 PolarCopilot Hub 后端 + Web 前端，不涉及 PolarClaw 和 SOTAgent"
          onChange={e => onChange({ ...data, scope: e.target.value })}
        />
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">约束条件</label>
          <button onClick={addConstraint} className="text-xs text-hub-accent hover:underline">+ 添加</button>
        </div>
        {(data.constraints ?? []).map((c, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input
              className="flex-1 bg-hub-bg border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
              value={c}
              placeholder={[
                '例：不引入新的外部依赖',
                '例：保持现有 API 向后兼容',
                '例：所有改动必须经过 SSoT 同步',
              ][i % 3]}
              onChange={e => {
                const next = [...(data.constraints ?? [])]
                next[i] = e.target.value
                onChange({ ...data, constraints: next })
              }}
            />
            <button onClick={() => {
              const next = (data.constraints ?? []).filter((_, j) => j !== i)
              onChange({ ...data, constraints: next })
            }} className="text-red-400 hover:text-red-300 text-sm px-1">✕</button>
          </div>
        ))}
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">成功标准</label>
          <button onClick={addCriteria} className="text-xs text-hub-accent hover:underline">+ 添加</button>
        </div>
        {(data.success_criteria ?? []).map((c, i) => (
          <div key={i} className="flex gap-2 mb-2">
            <input
              className="flex-1 bg-hub-bg border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
              value={c}
              placeholder={[
                '例：所有任务可通过 Prolusion 页面一键派发到 Slave',
                '例：Agent 完成后自动更新 polaris.json 对应 feature 状态',
                '例：生成的 Agent Prompt 可直接粘贴到 Cursor IDE 使用',
              ][i % 3]}
              onChange={e => {
                const next = [...(data.success_criteria ?? [])]
                next[i] = e.target.value
                onChange({ ...data, success_criteria: next })
              }}
            />
            <button onClick={() => {
              const next = (data.success_criteria ?? []).filter((_, j) => j !== i)
              onChange({ ...data, success_criteria: next })
            }} className="text-red-400 hover:text-red-300 text-sm px-1">✕</button>
          </div>
        ))}
      </div>
      <div>
        <label className="text-sm font-medium text-hub-text block mb-2">备注</label>
        <textarea
          className="w-full bg-hub-bg border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[60px] resize-y placeholder:text-hub-text-muted/40"
          value={data.notes ?? ''}
          placeholder="例：本次规划重点优化 Agent 协作效率，暂不涉及 UI 重构"
          onChange={e => onChange({ ...data, notes: e.target.value })}
        />
      </div>
    </div>
  )
}

function CodeMappingEditor({
  data, onChange,
}: { data: ProlusionCodeMapping; onChange: (d: ProlusionCodeMapping) => void }) {
  const addModule = () => onChange({
    ...data,
    modules: [...(data.modules ?? []), { name: '', description: '', files: [] }],
  })

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">模块拆分</label>
          <button onClick={addModule} className="text-xs text-hub-accent hover:underline">+ 添加模块</button>
        </div>
        {(data.modules ?? []).map((m, i) => (
          <div key={i} className="bg-hub-bg border border-hub-border rounded-lg p-3 mb-3">
            <div className="flex gap-2 mb-2">
              <input
                className="flex-1 bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
                value={m.name}
                placeholder="例：Hub 后端 API"
                onChange={e => {
                  const next = (data.modules ?? []).map((mm, j) => j === i ? { ...mm, name: e.target.value } : mm)
                  onChange({ ...data, modules: next })
                }}
              />
              <button onClick={() => {
                onChange({ ...data, modules: (data.modules ?? []).filter((_, j) => j !== i) })
              }} className="text-red-400 hover:text-red-300 text-sm px-2">✕</button>
            </div>
            <textarea
              className="w-full bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text mb-2 resize-y min-h-[40px] placeholder:text-hub-text-muted/40"
              value={m.description}
              placeholder="例：Express HTTP 路由，负责 Agent 注册、心跳、Prompt 管理"
              onChange={e => {
                const next = (data.modules ?? []).map((mm, j) => j === i ? { ...mm, description: e.target.value } : mm)
                onChange({ ...data, modules: next })
              }}
            />
            <input
              className="w-full bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text-muted placeholder:text-hub-text-muted/40"
              value={m.files.join(', ')}
              placeholder="例：hub/src/transport/http.ts, hub/src/persistence/db.ts"
              onChange={e => {
                const next = (data.modules ?? []).map((mm, j) => j === i ? { ...mm, files: e.target.value.split(',').map(s => s.trim()).filter(Boolean) } : mm)
                onChange({ ...data, modules: next })
              }}
            />
          </div>
        ))}
      </div>
      <div>
        <label className="text-sm font-medium text-hub-text block mb-2">依赖关系</label>
        <textarea
          className="w-full bg-hub-bg border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[60px] resize-y placeholder:text-hub-text-muted/40"
          value={(data.dependencies ?? []).join('\n')}
          placeholder="例：Web 前端 → Hub API → SQLite DB（每行一个）"
          onChange={e => onChange({ ...data, dependencies: e.target.value.split('\n').filter(Boolean) })}
        />
      </div>
      <div>
        <label className="text-sm font-medium text-hub-text block mb-2">备注</label>
        <textarea
          className="w-full bg-hub-bg border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[60px] resize-y placeholder:text-hub-text-muted/40"
          value={data.notes ?? ''}
          placeholder="例：重点关注 hub/src/transport/http.ts 中的 prolusion 路由"
          onChange={e => onChange({ ...data, notes: e.target.value })}
        />
      </div>
    </div>
  )
}

function TechOverviewEditor({
  data, onChange,
}: { data: ProlusionTechOverview; onChange: (d: ProlusionTechOverview) => void }) {
  const addRisk = () => onChange({
    ...data,
    risks: [...(data.risks ?? []), { description: '', severity: 'medium' as const }],
  })
  const addDecision = () => onChange({
    ...data,
    decisions: [...(data.decisions ?? []), { question: '', choice: '', rationale: '' }],
  })

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">风险识别</label>
          <button onClick={addRisk} className="text-xs text-hub-accent hover:underline">+ 添加</button>
        </div>
        {(data.risks ?? []).map((r, i) => (
          <div key={i} className="flex gap-2 mb-2 items-start">
            <input
              className="flex-1 bg-hub-bg border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
              value={r.description}
              placeholder={[
                '例：Hub 重启时 SSE 连接断开导致 Agent 丢失状态',
                '例：多 Slave 并发写同一文件可能冲突',
                '例：PolarClaw LLM 接口超时导致 Prompt 生成失败',
              ][i % 3]}
              onChange={e => {
                const next = (data.risks ?? []).map((rr, j) => j === i ? { ...rr, description: e.target.value } : rr)
                onChange({ ...data, risks: next })
              }}
            />
            <select
              className="bg-hub-bg border border-hub-border rounded px-2 py-1.5 text-sm text-hub-text"
              value={r.severity}
              onChange={e => {
                const next = (data.risks ?? []).map((rr, j) => j === i ? { ...rr, severity: e.target.value as 'low' | 'medium' | 'high' } : rr)
                onChange({ ...data, risks: next })
              }}
            >
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
            <button onClick={() => {
              onChange({ ...data, risks: (data.risks ?? []).filter((_, j) => j !== i) })
            }} className="text-red-400 hover:text-red-300 text-sm px-1 mt-1">✕</button>
          </div>
        ))}
      </div>
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-hub-text">技术决策</label>
          <button onClick={addDecision} className="text-xs text-hub-accent hover:underline">+ 添加</button>
        </div>
        {(data.decisions ?? []).map((d, i) => (
          <div key={i} className="bg-hub-bg border border-hub-border rounded-lg p-3 mb-3">
            <div className="flex gap-2 mb-2">
              <input
                className="flex-1 bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text placeholder:text-hub-text-muted/40"
                value={d.question}
                placeholder="例：数据存储用 SQLite 还是 PostgreSQL？"
                onChange={e => {
                  const next = (data.decisions ?? []).map((dd, j) => j === i ? { ...dd, question: e.target.value } : dd)
                  onChange({ ...data, decisions: next })
                }}
              />
              <button onClick={() => {
                onChange({ ...data, decisions: (data.decisions ?? []).filter((_, j) => j !== i) })
              }} className="text-red-400 hover:text-red-300 text-sm px-2">✕</button>
            </div>
            <input
              className="w-full bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text mb-2 placeholder:text-hub-text-muted/40"
              value={d.choice}
              placeholder="例：SQLite — 嵌入式无需额外服务"
              onChange={e => {
                const next = (data.decisions ?? []).map((dd, j) => j === i ? { ...dd, choice: e.target.value } : dd)
                onChange({ ...data, decisions: next })
              }}
            />
            <input
              className="w-full bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text-muted placeholder:text-hub-text-muted/40"
              value={d.rationale}
              placeholder="例：开发环境零配置，部署简单，性能满足当前规模需求"
              onChange={e => {
                const next = (data.decisions ?? []).map((dd, j) => j === i ? { ...dd, rationale: e.target.value } : dd)
                onChange({ ...data, decisions: next })
              }}
            />
          </div>
        ))}
      </div>
      <div>
        <label className="text-sm font-medium text-hub-text block mb-2">备注</label>
        <textarea
          className="w-full bg-hub-bg border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[60px] resize-y placeholder:text-hub-text-muted/40"
          value={data.notes ?? ''}
          placeholder="例：优先使用已有技术栈，避免引入新框架增加学习成本"
          onChange={e => onChange({ ...data, notes: e.target.value })}
        />
      </div>
    </div>
  )
}

function TaskAllocationEditor({
  data, onChange,
}: { data: ProlusionTaskItem[]; onChange: (d: ProlusionTaskItem[]) => void }) {
  const updateTask = (i: number, patch: Partial<ProlusionTaskItem>) => {
    const next = data.map((t, j) => j === i ? { ...t, ...patch } : t)
    onChange(next)
  }
  const addTask = () => onChange([...data, { title: '', description: '', priority: 50 }])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-hub-text">任务包 ({data.length} 个任务)</label>
        <button onClick={addTask} className="text-xs text-hub-accent hover:underline">+ 添加任务</button>
      </div>
      {data.map((t, i) => (
        <div key={i} className="bg-hub-bg border border-hub-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm text-hub-text-muted font-mono">#{i + 1}</span>
            <input
              className="flex-1 bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text font-medium placeholder:text-hub-text-muted/40"
              value={t.title}
              placeholder="例：实现 Prolusion dispatch 到 Slave 的自动分配"
              onChange={e => updateTask(i, { title: e.target.value })}
            />
            <select
              className="bg-hub-surface border border-hub-border rounded px-2 py-1.5 text-sm text-hub-text w-20"
              value={t.priority ?? 50}
              onChange={e => updateTask(i, { priority: Number(e.target.value) })}
            >
              <option value={90}>P0 紧急</option>
              <option value={70}>P1 高</option>
              <option value={50}>P2 中</option>
              <option value={30}>P3 低</option>
            </select>
            <button onClick={() => onChange(data.filter((_, j) => j !== i))}
              className="text-red-400 hover:text-red-300 text-sm px-1">✕</button>
          </div>
          <textarea
            className="w-full bg-hub-surface border border-hub-border rounded px-3 py-2 text-sm text-hub-text min-h-[60px] resize-y mb-2 placeholder:text-hub-text-muted/40"
            value={t.description}
            placeholder="例：修改 dispatch API，查询空闲 Slave 列表，自动分配任务并通过 Hub 事件通知 Slave"
            onChange={e => updateTask(i, { description: e.target.value })}
          />
          <div className="flex gap-3">
            <input
              className="flex-1 bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text-muted placeholder:text-hub-text-muted/40"
              value={t.module ?? ''}
              placeholder="例：Hub 后端"
              onChange={e => updateTask(i, { module: e.target.value || undefined })}
            />
            <input
              className="flex-1 bg-hub-surface border border-hub-border rounded px-3 py-1.5 text-sm text-hub-text-muted placeholder:text-hub-text-muted/40"
              value={t.agent_type ?? ''}
              placeholder="例：slave（solo 或 slave）"
              onChange={e => updateTask(i, { agent_type: e.target.value || undefined })}
            />
          </div>
        </div>
      ))}
      {data.length === 0 && (
        <div className="text-center py-8 text-hub-text-muted text-sm">
          暂无任务，点击「+ 添加任务」开始构建任务包
        </div>
      )}
    </div>
  )
}

function PlanDetail({
  plan, onBack, onReload,
}: { plan: ProlusionPlan; onBack: () => void; onReload: () => void }) {
  const [localPlan, setLocalPlan] = useState(plan)
  const [viewStage, setViewStage] = useState(plan.current_stage)
  const [saving, setSaving] = useState(false)
  const [dispatching, setDispatching] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [aiPlanning, setAiPlanning] = useState(false)
  const [generatedPrompts, setGeneratedPrompts] = useState<Array<{ task_index: number; task_title: string; agent_type: string; prompt: string }>>([])
  const [copiedPrompts, setCopiedPrompts] = useState<Set<number>>(new Set())
  const [genModel, setGenModel] = useState<string | undefined>()
  const [taskMode, setTaskMode] = useState<'auto'|'solo-slaves'|'solo-only'>('auto')

  useEffect(() => { setLocalPlan(plan); setViewStage(plan.current_stage) }, [plan])

  const viewingStageMeta = STAGES[viewStage - 1]
  const isViewingCurrentStage = viewStage === localPlan.current_stage
  const isViewingFutureStage = viewStage > localPlan.current_stage

  const save = async () => {
    setSaving(true)
    try {
      await api.prolusion.update(localPlan.id, {
        demand_analysis: localPlan.demand_analysis,
        code_mapping: localPlan.code_mapping,
        tech_overview: localPlan.tech_overview,
        task_allocation: localPlan.task_allocation,
      })
      onReload()
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  const advance = async () => {
    await save()
    try {
      const result = await api.prolusion.advance(localPlan.id)
      setLocalPlan(prev => ({ ...prev, current_stage: result.current_stage, status: result.status }))
      onReload()
    } catch (e) { console.error(e) }
  }

  const dispatch = async () => {
    setDispatching(true)
    try {
      const result = await api.prolusion.dispatch(localPlan.id) as {
        ok: boolean; task_ids: string[]
        assigned?: number; unassigned?: number
        assignments?: Array<{ task_id: string; slave_id: string; slave_name: string | null; task_title: string }>
      }
      const lines: string[] = [`已派发 ${result.task_ids.length} 个任务`]
      if (result.assigned != null) {
        lines.push(`已分配 Slave: ${result.assigned} 个`)
        if (result.assignments?.length) {
          for (const a of result.assignments) {
            lines.push(`  → ${a.task_title} → ${a.slave_name || a.slave_id}`)
          }
        }
      }
      if (result.unassigned) {
        lines.push(`未分配（无空闲 Slave）: ${result.unassigned} 个，已入 Task Board 等待领取`)
      }
      alert(lines.join('\n'))
      onReload()
    } catch (e) { console.error(e) }
    finally { setDispatching(false) }
  }

  const generatePrompts = async () => {
    setGenerating(true)
    try {
      const result = await api.prolusion.generatePrompts(localPlan.id)
      setGeneratedPrompts(result.prompts)
      setGenModel(result.model)
    } catch (e) { console.error(e); alert(`生成失败: ${e}`) }
    finally { setGenerating(false) }
  }

  const aiPlan = async () => {
    setAiPlanning(true)
    try {
      await save()
      const result = await api.prolusion.aiPlan(localPlan.id, taskMode)
      if (result.ok) {
        onReload()
        setViewStage(4)
      }
    } catch (e) { console.error(e); alert(`AI 规划失败: ${e}`) }
    finally { setAiPlanning(false) }
  }

  const deletePlan = async () => {
    if (!confirm('确定要删除此规划吗？删除后无法恢复。')) return
    try {
      await api.prolusion.remove(localPlan.id)
      onBack()
    } catch (e) {
      console.error(e)
      alert(`删除失败: ${e}`)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <button onClick={onBack} className="text-hub-text-muted hover:text-hub-text text-sm">← 返回列表</button>
        <h2 className="text-xl font-bold text-[#e6edf3] flex-1">{localPlan.title}</h2>
        <button
          onClick={deletePlan}
          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded transition-colors"
        >
          删除
        </button>
        <StatusBadge status={localPlan.status} />
      </div>

      <div className="bg-hub-surface border border-hub-border rounded-xl p-4">
        <p className="text-sm text-hub-text-muted mb-3">高层目标</p>
        <p className="text-sm text-hub-text whitespace-pre-wrap">{localPlan.goal}</p>
      </div>

      <div className="flex items-center justify-between">
        <StageProgress current={localPlan.current_stage} viewing={viewStage} onSelect={setViewStage} />
        <div className="flex items-center gap-1 text-sm">
          {STAGES.map(s => {
            const isActive = s.num === viewStage
            const isCompleted = s.num < localPlan.current_stage
            const isCurrent = s.num === localPlan.current_stage
            return (
              <button
                key={s.num}
                type="button"
                onClick={() => setViewStage(s.num)}
                className={`px-2.5 py-1.5 rounded-lg transition-all ${
                  isActive
                    ? 'bg-hub-accent/20 text-hub-accent font-medium'
                    : isCompleted
                      ? 'text-emerald-400 hover:bg-emerald-500/10 cursor-pointer'
                      : isCurrent
                        ? 'text-hub-text hover:bg-hub-accent/10 cursor-pointer'
                        : 'text-hub-text-muted/50 cursor-default'
                }`}
              >
                {s.icon} {s.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className={`bg-hub-surface border rounded-xl p-5 ${
        isViewingFutureStage ? 'border-hub-border/50 opacity-60' : 'border-hub-border'
      }`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-[#e6edf3]">
            {viewingStageMeta?.icon} 阶段 {viewStage}：{viewingStageMeta?.label}
          </h3>
          {!isViewingCurrentStage && viewStage < localPlan.current_stage && (
            <span className="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">已完成 ✓</span>
          )}
          {isViewingFutureStage && (
            <span className="text-xs text-hub-text-muted bg-hub-bg px-2 py-1 rounded">尚未开始</span>
          )}
        </div>

        {isViewingFutureStage ? (
          <div className="text-center py-8 text-hub-text-muted text-sm">
            此阶段尚未解锁，请先完成前序阶段
          </div>
        ) : (
          <>
            {viewStage === 1 && (
              <DemandAnalysisEditor
                data={localPlan.demand_analysis}
                onChange={d => setLocalPlan(prev => ({ ...prev, demand_analysis: d }))}
              />
            )}
            {viewStage === 2 && (
              <CodeMappingEditor
                data={localPlan.code_mapping}
                onChange={d => setLocalPlan(prev => ({ ...prev, code_mapping: d }))}
              />
            )}
            {viewStage === 3 && (
              <TechOverviewEditor
                data={localPlan.tech_overview}
                onChange={d => setLocalPlan(prev => ({ ...prev, tech_overview: d }))}
              />
            )}
            {viewStage === 4 && (
              <TaskAllocationEditor
                data={localPlan.task_allocation}
                onChange={d => setLocalPlan(prev => ({ ...prev, task_allocation: d }))}
              />
            )}
          </>
        )}
      </div>

      <div className="flex justify-end gap-3">
        {!isViewingFutureStage && (
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 text-sm bg-hub-surface border border-hub-border rounded-lg text-hub-text hover:bg-hub-bg disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        )}
        {isViewingCurrentStage && localPlan.current_stage < 4 && (
          <div className="flex items-center gap-2">
            <select
              value={taskMode}
              onChange={(e) => setTaskMode(e.target.value as any)}
              disabled={aiPlanning}
              className="bg-hub-surface border border-hub-border text-hub-text-muted hover:text-hub-text text-sm rounded-lg px-2 py-2 focus:outline-none focus:border-hub-accent/50 cursor-pointer"
            >
              <option value="auto">智能选择形式</option>
              <option value="solo-slaves">1 Solo + 多个 Slave</option>
              <option value="solo-only">仅 1 个 Solo</option>
            </select>
            <button
              onClick={aiPlan}
              disabled={aiPlanning}
              className="px-4 py-2 text-sm bg-purple-600 text-white rounded-lg hover:bg-purple-500 disabled:opacity-50"
            >
              {aiPlanning ? 'AI 规划中（LLM）...' : '⚡ AI 自动补全后续阶段'}
            </button>
            <button
              onClick={advance}
              className="px-4 py-2 text-sm bg-hub-accent text-white rounded-lg hover:bg-hub-accent/80"
            >
              进入下一阶段 →
            </button>
          </div>
        )}
        {isViewingCurrentStage && localPlan.current_stage === 4 && localPlan.status !== 'dispatched' && (
          <button
            onClick={dispatch}
            disabled={dispatching}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 disabled:opacity-50"
          >
            {dispatching ? '派发中...' : '派发任务到 Agent'}
          </button>
        )}
        {isViewingCurrentStage && localPlan.current_stage === 4 && (
          <button
            onClick={generatePrompts}
            disabled={generating}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {generating ? '生成中（LLM）...' : '生成 Agent Prompts'}
          </button>
        )}
        {!isViewingCurrentStage && !isViewingFutureStage && (
          <button
            onClick={() => setViewStage(localPlan.current_stage)}
            className="px-4 py-2 text-sm bg-hub-accent/20 text-hub-accent rounded-lg hover:bg-hub-accent/30"
          >
            回到当前阶段 (阶段 {localPlan.current_stage})
          </button>
        )}
      </div>

      {generatedPrompts.length > 0 && (() => {
        const pending = generatedPrompts.filter((_, i) => !copiedPrompts.has(i))
        const archived = generatedPrompts.filter((_, i) => copiedPrompts.has(i))
        return (
          <div className="bg-hub-surface border border-hub-border rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-[#e6edf3]">
                Agent Prompts
                {pending.length > 0 && <span className="ml-2 text-xs text-hub-text-muted font-normal">{pending.length} 待使用</span>}
              </h3>
              {genModel && <span className="text-xs text-hub-text-muted font-mono">model: {genModel}</span>}
            </div>
            <div className="space-y-3">
              {generatedPrompts.map((p, i) => {
                const isCopied = copiedPrompts.has(i)
                return (
                  <div key={i} className={`border rounded-lg p-4 transition-all ${isCopied ? 'border-emerald-500/30 bg-emerald-500/5 opacity-60' : 'border-zinc-700/50'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">{p.agent_type}</span>
                        <span className={`text-sm font-medium ${isCopied ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{p.task_title}</span>
                        {isCopied && <span className="text-xs text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">已使用 ✓</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {isCopied && (
                          <button
                            onClick={() => setCopiedPrompts(prev => { const next = new Set(prev); next.delete(i); return next })}
                            className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                          >
                            撤销
                          </button>
                        )}
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(p.prompt)
                            setCopiedPrompts(prev => new Set(prev).add(i))
                          }}
                          className={`px-3 py-1 text-xs rounded transition-colors ${isCopied ? 'bg-emerald-500/20 text-emerald-400' : 'bg-hub-accent/20 text-hub-accent hover:bg-hub-accent/30'}`}
                        >
                          {isCopied ? '再次复制' : '复制'}
                        </button>
                      </div>
                    </div>
                    {!isCopied && (
                      <pre className="text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto bg-zinc-900/50 rounded p-3">{p.prompt}</pre>
                    )}
                  </div>
                )
              })}
            </div>
            {archived.length > 0 && pending.length > 0 && (
              <p className="text-xs text-zinc-600 text-center mt-3">{archived.length} 个已使用，{pending.length} 个待使用</p>
            )}
          </div>
        )
      })()}

    </div>
  )
}

export default function ProlusionPage() {
  const [plans, setPlans] = useState<ProlusionPlanSummary[]>([])
  const [selectedPlan, setSelectedPlan] = useState<ProlusionPlan | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const load = useCallback(async () => {
    try {
      const data = await api.prolusion.list()
      setPlans(data)
    } catch (e) { console.error(e) }
  }, [])

  const loadDetail = useCallback(async (id: string) => {
    try {
      const data = await api.prolusion.get(id)
      setSelectedPlan(data)
    } catch (e) { console.error(e) }
  }, [])

  const deletePlan = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (!confirm('确定要删除此规划吗？删除后无法恢复。')) return
    try {
      await api.prolusion.remove(id)
      load()
    } catch (err) {
      console.error(err)
      alert(`删除失败: ${err}`)
    }
  }

  useEffect(() => { load() }, [load])
  useUiSse(load)

  if (selectedPlan) {
    return (
      <div className="py-2">
        <PlanDetail
          plan={selectedPlan}
          onBack={() => { setSelectedPlan(null); load() }}
          onReload={() => loadDetail(selectedPlan.id)}
        />
      </div>
    )
  }

  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-[#e6edf3]">Prolusion 整体规划</h1>
          <p className="text-sm text-hub-text-muted mt-1">
            4 阶段结构化规划：需求分析 → 代码映射 → 技术概览 → 任务分配
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-hub-accent text-white rounded-lg hover:bg-hub-accent/80"
        >
          + 创建规划
        </button>
      </div>

      {plans.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-3xl mb-3">📋</p>
          <p className="text-lg text-hub-text-muted">还没有规划</p>
          <p className="text-sm text-hub-text-muted mt-1">创建你的第一个整体规划，开始 4 阶段流程</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-4 px-4 py-2 text-sm bg-hub-accent text-white rounded-lg hover:bg-hub-accent/80"
          >
            创建规划
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {plans.map(p => (
            <div
              key={p.id}
              onClick={() => loadDetail(p.id)}
              className="bg-hub-surface border border-hub-border rounded-xl p-5 cursor-pointer hover:border-hub-accent/50 transition-colors group"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-[#e6edf3]">{p.title}</h3>
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => deletePlan(e, p.id)}
                    className="opacity-0 group-hover:opacity-100 px-2 py-1 text-xs text-red-400 hover:text-red-300 bg-red-400/10 hover:bg-red-400/20 rounded transition-all"
                  >
                    删除
                  </button>
                  <StageProgress current={p.current_stage} />
                  <StatusBadge status={p.status} />
                </div>
              </div>
              <p className="text-sm text-hub-text-muted line-clamp-2">{p.goal}</p>
              <div className="flex items-center gap-4 mt-3 text-xs text-hub-text-muted">
                <span>创建于 {new Date(p.created_at).toLocaleDateString('zh-CN')}</span>
                {p.created_by && <span>by {p.created_by}</span>}
                <span>当前：{STAGES[p.current_stage - 1]?.label ?? '已完成'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && <CreatePlanDialog onCreated={load} onClose={() => setShowCreate(false)} />}
    </div>
  )
}
