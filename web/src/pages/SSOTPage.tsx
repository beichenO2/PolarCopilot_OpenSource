import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type PolarisProject, type PolarisRequirement, type PolarisFeature, type SSOTAnnotation, type AuditProjectStatus, type InboxFlag } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import { EcoTree } from '../components/EcoTree'
import { TopicsPanel } from '../components/TopicsPanel'

/* ─── Badges ─────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    done: 'bg-emerald-500/20 text-emerald-400',
    'in-progress': 'bg-amber-500/20 text-amber-400',
    planned: 'bg-blue-500/20 text-blue-400',
    blocked: 'bg-red-500/20 text-red-400',
    active: 'bg-emerald-500/20 text-emerald-400',
  }
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] ?? 'bg-zinc-500/20 text-zinc-400'}`}>
      {status}
    </span>
  )
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    infra: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    knowledge: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    app: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    domain: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  }
  return (
    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${colors[tier] ?? 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30'}`}>
      {tier}
    </span>
  )
}

function ProgressBar({ features }: { features: PolarisFeature[] }) {
  const done = features.filter(f => f.status === 'done').length
  const total = features.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-zinc-400 tabular-nums">{done}/{total}</span>
    </div>
  )
}

/* ─── Inline Editable Field ──────────────────────────────── */

function EditableText({
  value, fieldPath, className, tag: Tag = 'span', onSave,
}: {
  value: string; fieldPath: string; className?: string; tag?: 'span' | 'p' | 'div'
  onSave?: (fieldPath: string, newValue: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setDraft(value) }, [value])
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  const commit = () => {
    setEditing(false)
    if (draft.trim() !== value && onSave) onSave(fieldPath, draft.trim())
  }

  if (editing) {
    return (
      <textarea
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
          if (e.key === 'Escape') { setDraft(value); setEditing(false) }
        }}
        rows={Math.max(1, draft.split('\n').length)}
        className={`w-full bg-zinc-900 border border-blue-500/50 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-blue-500 resize-none ${className ?? ''}`}
      />
    )
  }

  return (
    <Tag
      onClick={() => setEditing(true)}
      className={`cursor-text hover:bg-zinc-800/50 rounded px-0.5 -mx-0.5 transition-colors ${className ?? ''}`}
      title="点击编辑"
    >
      {value || <span className="text-zinc-600 italic">空</span>}
    </Tag>
  )
}

/* ─── Selection Annotator ────────────────────────────────── */

function SelectionAnnotator({
  containerRef, fieldPath, projectName, annotations, onCreated,
}: {
  containerRef: React.RefObject<HTMLDivElement | null>
  fieldPath: string; projectName: string
  annotations: SSOTAnnotation[]
  onCreated: () => void
}) {
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null)
  const [note, setNote] = useState('')
  const [sending, setSending] = useState(false)
  const popupRef = useRef<HTMLDivElement>(null)
  const fieldAnns = annotations.filter(a => a.field_path === fieldPath)

  const handleMouseUp = useCallback((e: MouseEvent) => {
    if (popupRef.current?.contains(e.target as Node)) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) { setSelection(null); return }
    const range = sel.getRangeAt(0)
    if (!containerRef.current?.contains(range.commonAncestorContainer)) { setSelection(null); return }
    const text = sel.toString().trim()
    if (text.length < 2) { setSelection(null); return }
    const rect = range.getBoundingClientRect()
    const containerRect = containerRef.current.getBoundingClientRect()
    setSelection({
      text,
      top: rect.bottom - containerRect.top + 4,
      left: Math.max(0, rect.left - containerRect.left),
    })
    setNote('')
  }, [containerRef])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.addEventListener('mouseup', handleMouseUp)
    return () => el.removeEventListener('mouseup', handleMouseUp)
  }, [containerRef, handleMouseUp])

  const submit = async () => {
    if (!note.trim() || !selection) return
    setSending(true)
    try {
      await api.polaris.annotate(projectName, {
        field_path: fieldPath,
        author: 'User',
        author_type: 'user',
        text: `[${selection.text}] ${note.trim()}`,
      })
      setSelection(null)
      setNote('')
      window.getSelection()?.removeAllRanges()
      onCreated()
    } finally { setSending(false) }
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (selection && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [selection])

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 300) + 'px'
  }, [])

  return (
    <>
      {selection && (
        <div
          ref={popupRef}
          onMouseDown={e => e.stopPropagation()}
          onMouseUp={e => e.stopPropagation()}
          className="absolute z-20 bg-zinc-900 border border-blue-500/50 rounded-lg p-3 shadow-xl"
          style={{ top: selection.top, left: 0, right: 0 }}
        >
          <div className="text-xs text-zinc-500 mb-1.5">批注选中文本：</div>
          <div className="text-xs text-blue-400 bg-blue-500/10 rounded px-2 py-1 mb-2 line-clamp-2">
            &ldquo;{selection.text}&rdquo;
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={note}
              onChange={e => { setNote(e.target.value); autoResize() }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() }
                if (e.key === 'Escape') { setSelection(null); window.getSelection()?.removeAllRanges() }
              }}
              placeholder="输入批注... (⌘+Enter 发送, Esc 取消)"
              rows={2}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-blue-500 focus:outline-none leading-[1.5] resize-none max-h-[300px]"
              disabled={sending}
            />
            <button onClick={submit} disabled={sending || !note.trim()} className="px-4 py-2.5 text-sm rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 disabled:opacity-40 whitespace-nowrap">
              发送
            </button>
          </div>
        </div>
      )}

      {fieldAnns.length > 0 && (
        <div className="mt-2 space-y-1">
          {fieldAnns.map(ann => (
            <div
              key={ann.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-ssot-annotation', JSON.stringify(ann))
                e.dataTransfer.effectAllowed = 'copy'
              }}
              className="border-l-2 border-blue-500/40 pl-2 text-xs flex items-start gap-1.5 cursor-grab active:cursor-grabbing hover:bg-zinc-800/40 rounded-r pr-1 transition-colors group/annitem"
              title="拖拽到左侧主题"
            >
              <span className="text-zinc-700 group-hover/annitem:text-zinc-500 shrink-0 mt-px select-none transition-colors">⠿</span>
              <span className={`font-medium flex-shrink-0 ${ann.author_type === 'agent' ? 'text-amber-400' : 'text-blue-400'}`}>{ann.author}</span>
              <span className="text-zinc-400 flex-1">{ann.text}</span>
              <span className="text-zinc-600 flex-shrink-0 text-[10px]">{new Date(ann.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ─── Requirement Card ───────────────────────────────────── */

function RequirementCard({
  req, annotations, projectName, onAnnotationCreated, onSave,
}: {
  req: PolarisRequirement; annotations: SSOTAnnotation[]
  projectName: string; onAnnotationCreated: () => void
  onSave?: (fieldPath: string, newValue: string) => void
}) {
  const features = req.features ?? []
  const blockers = req.blockers ?? []
  const done = features.filter(f => f.status === 'done').length
  const allDone = done === features.length
  const hasBlockers = blockers.length > 0
  const cardRef = useRef<HTMLDivElement>(null)
  const [techOpen, setTechOpen] = useState(false)

  return (
    <div id={`req-${req.id}`} ref={cardRef} className="relative border border-zinc-800 rounded-lg overflow-hidden group scroll-mt-4">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        <code className="text-xs text-zinc-500 font-mono">{req.id}</code>
        <StatusBadge status={allDone ? 'done' : hasBlockers ? 'blocked' : 'in-progress'} />
        <span className="text-xs text-zinc-500 ml-auto tabular-nums">{done}/{features.length} done</span>
      </div>

      <div className="px-4 py-3 relative">
        <EditableText value={req.need} fieldPath={`${req.id}.need`} className="text-sm text-zinc-200 font-medium" tag="p" onSave={onSave} />

        <div className="border-l-2 border-zinc-700 pl-3 my-3">
          <p className="text-xs text-zinc-500 font-medium uppercase tracking-wider mb-0.5">实现方案</p>
          <EditableText value={req.approach} fieldPath={`${req.id}.approach`} className="text-xs text-zinc-400" tag="p" onSave={onSave} />
        </div>

        {(req.technical_details || onSave) && (
          <div className="my-3">
            <button
              onClick={() => setTechOpen(!techOpen)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors group/tech"
            >
              <span className={`transition-transform duration-150 ${techOpen ? 'rotate-90' : ''}`}>▶</span>
              <span className="font-medium uppercase tracking-wider">技术描述</span>
              {!req.technical_details && <span className="text-zinc-600 italic font-normal normal-case tracking-normal">空</span>}
            </button>
            {techOpen && (
              <div className="mt-2 border-l-2 border-blue-500/30 pl-3">
                <EditableText
                  value={req.technical_details ?? ''}
                  fieldPath={`${req.id}.technical_details`}
                  className="text-xs text-zinc-400 whitespace-pre-wrap"
                  tag="div"
                  onSave={onSave}
                />
              </div>
            )}
          </div>
        )}

        <ProgressBar features={features} />

        <div className="mt-3 space-y-1">
          {features.map((f, i) => {
            const hasStructured = (f.tech?.length ?? 0) > 0 || (f.interfaces?.length ?? 0) > 0 ||
              (f.behavior?.length ?? 0) > 0 || (f.depends_on?.length ?? 0) > 0
            return (
              <div key={i} className="border border-zinc-800/50 rounded px-3 py-2">
                <div className="flex items-center gap-2">
                  <EditableText value={f.name} fieldPath={`${req.id}.features[${i}].name`} className="text-xs text-zinc-300 font-medium" onSave={onSave} />
                  <StatusBadge status={f.status} />
                </div>
                {hasStructured ? (
                  <div className="mt-1.5 ml-2 space-y-0.5 text-xs">
                    {f.tech && f.tech.length > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-zinc-500 font-mono flex-shrink-0">tech:</span>
                        <span className="text-zinc-400">{f.tech.join(', ')}</span>
                      </div>
                    )}
                    {f.interfaces && f.interfaces.length > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-zinc-500 font-mono flex-shrink-0">interfaces:</span>
                        <span className="text-zinc-400 font-mono">{f.interfaces.join(', ')}</span>
                      </div>
                    )}
                    {f.behavior && f.behavior.length > 0 && (
                      <div>
                        <span className="text-zinc-500 font-mono">behavior:</span>
                        <ul className="ml-4 mt-0.5 list-disc list-inside text-zinc-400">
                          {f.behavior.map((b, bi) => <li key={bi}>{b}</li>)}
                        </ul>
                      </div>
                    )}
                    {f.depends_on && f.depends_on.length > 0 && (
                      <div className="flex items-start gap-2">
                        <span className="text-zinc-500 font-mono flex-shrink-0">depends_on:</span>
                        <span className="text-zinc-400">{f.depends_on.join(', ')}</span>
                      </div>
                    )}
                  </div>
                ) : f.description ? (
                  <EditableText value={f.description} fieldPath={`${req.id}.features[${i}].description`} className="text-xs text-zinc-400 mt-1" onSave={onSave} />
                ) : null}
              </div>
            )
          })}
        </div>

        {hasBlockers && (
          <div className="mt-3 p-2 bg-red-500/5 border border-red-500/20 rounded">
            <p className="text-xs text-red-400 font-medium mb-1">阻塞项</p>
            {blockers.map((b, i) => (
              <EditableText key={i} value={b} fieldPath={`${req.id}.blockers[${i}]`} className="text-xs text-red-300/70" tag="p" onSave={onSave} />
            ))}
          </div>
        )}

        <SelectionAnnotator
          containerRef={cardRef}
          fieldPath={req.id}
          projectName={projectName}
          annotations={annotations}
          onCreated={onAnnotationCreated}
        />

        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-zinc-600">
          选中文本即可批注
        </div>
      </div>
    </div>
  )
}

/* ─── Project Detail ─────────────────────────────────────── */

function ProjectDetail({
  project, annotations, onAnnotationCreated, onSave,
}: {
  project: PolarisProject; annotations: SSOTAnnotation[]
  onAnnotationCreated: () => void
  onSave?: (fieldPath: string, newValue: string) => void
}) {
  const totalFeatures = project.requirements.flatMap(r => r.features ?? []).length
  const doneFeatures = project.requirements.flatMap(r => r.features ?? []).filter(f => f.status === 'done').length
  const blockedReqs = project.requirements.filter(r => (r.blockers ?? []).length > 0).length
  const pct = totalFeatures > 0 ? Math.round((doneFeatures / totalFeatures) * 100) : 0
  const headerRef = useRef<HTMLDivElement>(null)

  return (
    <div className="space-y-5">
      <div ref={headerRef} className="relative">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-100">{project.name}</h1>
          <TierBadge tier={project.tier} />
          <StatusBadge status={project.status} />
          {project.version && <span className="text-xs text-zinc-500">v{project.version}</span>}
        </div>
        <EditableText value={project.description} fieldPath="description" className="text-sm text-zinc-400 mt-1 block" tag="p" onSave={onSave} />
        <SelectionAnnotator containerRef={headerRef} fieldPath="project" projectName={project.name} annotations={annotations} onCreated={onAnnotationCreated} />
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard value={String(project.requirements.length)} label="需求数" />
        <StatCard value={`${doneFeatures}/${totalFeatures}`} label="已完成功能" accent={pct === 100} />
        <StatCard value={String(blockedReqs)} label="阻塞中" warn={blockedReqs > 0} />
        <StatCard value={`${pct}%`} label="完成度" accent={pct === 100} />
      </div>

      {project.tech && (
        <div className="border border-zinc-800 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-zinc-800 bg-zinc-900/50">
            <span className="text-xs text-zinc-500 font-medium uppercase tracking-wider">技术栈</span>
          </div>
          <div className="px-4 py-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            {Object.entries(project.tech).map(([cat, items]) => (
              <div key={cat}>
                <span className="text-zinc-500 font-medium">{cat}:</span>
                {Object.entries(items).map(([k, v]) => (
                  <span key={k} className="text-zinc-400 ml-1">{k}={v}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {project.requirements.map(req => (
          <RequirementCard
            key={req.id}
            req={req}
            annotations={annotations}
            projectName={project.name}
            onAnnotationCreated={onAnnotationCreated}
            onSave={onSave}
          />
        ))}
      </div>

      {project.contacts && (
        <p className="text-xs text-zinc-600 pt-2">
          最后更新 {project.contacts.last_updated}，由 {project.contacts.updated_by}
        </p>
      )}
    </div>
  )
}

function StatCard({ value, label, accent, warn }: { value: string; label: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className="border border-zinc-800 rounded-lg px-3 py-2 text-center">
      <div className={`text-lg font-semibold tabular-nums ${warn ? 'text-amber-400' : accent ? 'text-emerald-400' : 'text-zinc-200'}`}>
        {value}
      </div>
      <div className="text-xs text-zinc-500">{label}</div>
    </div>
  )
}

/* ─── Audit Status Components ──────────────────────── */

function AuditStatCard({ label, count, color, icon }: { label: string; count: number; color: string; icon: string }) {
  const colorMap: Record<string, string> = {
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    red: 'border-red-500/30 bg-red-500/5',
    zinc: 'border-zinc-500/30 bg-zinc-500/5',
  }
  const textColorMap: Record<string, string> = {
    emerald: 'text-emerald-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    zinc: 'text-zinc-400',
  }
  return (
    <div className={`border ${colorMap[color] ?? colorMap.zinc} rounded-lg px-3 py-2 text-center`}>
      <div className={`text-2xl font-semibold ${textColorMap[color] ?? textColorMap.zinc}`}>
        {icon} {count}
      </div>
      <div className="text-xs text-zinc-500 mt-1">{label}</div>
    </div>
  )
}

function InboxFlagCard({ flag, onViewReport }: { flag: InboxFlag; onViewReport: (flag: InboxFlag) => void }) {
  const severityColorMap: Record<string, string> = {
    clean: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    minor: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    major: 'bg-red-500/10 border-red-500/20 text-red-400',
    critical: 'bg-red-500/20 border-red-500/40 text-red-400',
    unknown: 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400',
  }
  const colors = severityColorMap[flag.severity] ?? severityColorMap.unknown
  const findingCount = flag.findings?.length ?? 0

  return (
    <div className={`border rounded-lg px-3 py-2 flex items-center gap-3 ${colors}`}>
      <span className="text-xs font-medium uppercase">{flag.project}</span>
      <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-black/20">{flag.severity}</span>
      {findingCount > 0 && (
        <span className="text-xs text-zinc-500">{findingCount} 个问题</span>
      )}
      <button
        onClick={() => onViewReport(flag)}
        className="ml-auto text-xs px-2 py-1 rounded bg-black/20 hover:bg-black/40 transition-colors"
      >
        查看报告
      </button>
    </div>
  )
}

function AuditReportModal({ report, onClose }: { report: Record<string, unknown> | null; onClose: () => void }) {
  if (!report) return null

  const findings = report.findings as Array<{ severity?: string; file?: string; description?: string }> ?? []
  const title = report.title as string ?? '审计报告'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-xl w-[700px] max-h-[80vh] overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200 text-lg leading-none">&times;</button>
        </div>
        <div className="overflow-y-auto max-h-[calc(80vh-60px)] p-5">
          {typeof report.summary === 'string' && report.summary && (
            <p className="text-sm text-zinc-400 mb-4">{report.summary}</p>
          )}
          {findings.length > 0 ? (
            <div className="space-y-2">
              {findings.map((f, i) => (
                <details key={i} className="border border-zinc-800 rounded-lg overflow-hidden">
                  <summary className="px-4 py-2 bg-zinc-800/50 cursor-pointer hover:bg-zinc-800 transition-colors flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      f.severity === 'critical' ? 'bg-red-500 animate-pulse' :
                      f.severity === 'major' ? 'bg-red-500' :
                      f.severity === 'minor' ? 'bg-amber-500' :
                      f.severity === 'clean' ? 'bg-emerald-500' : 'bg-zinc-500'
                    }`} />
                    <span className="text-sm text-zinc-300">{f.file ?? '未知文件'}</span>
                    <span className="text-xs text-zinc-500 ml-auto">{f.severity ?? 'unknown'}</span>
                  </summary>
                  <div className="px-4 py-3 text-xs text-zinc-400 whitespace-pre-wrap">
                    {f.description ?? JSON.stringify(f, null, 2)}
                  </div>
                </details>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-zinc-500">
              <pre className="text-xs text-zinc-600 text-left overflow-auto max-h-96">
                {JSON.stringify(report, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Main Page ──────────────────────────────────────────── */

export function SSOTPage() {
  const [searchParams] = useSearchParams()
  const [projects, setProjects] = useState<PolarisProject[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<SSOTAnnotation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Audit state
  const [auditStatus, setAuditStatus] = useState<AuditProjectStatus[]>([])
  const [inboxFlags, setInboxFlags] = useState<InboxFlag[]>([])
  const [selectedReport, setSelectedReport] = useState<Record<string, unknown> | null>(null)
  const [, setAuditLoading] = useState(false)

  const loadAnnotations = useCallback((name: string) => {
    api.polaris.annotations(name).then(d => setAnnotations(d.annotations)).catch(() => {})
  }, [])

  const loadAuditData = useCallback(() => {
    setAuditLoading(true)
    Promise.allSettled([
      api.ssotAudit.getAuditStatus(),
      api.ssotAudit.getInboxFlags(),
    ]).then(([auditRes, flagsRes]) => {
      if (auditRes.status === 'fulfilled') setAuditStatus(auditRes.value.projects)
      if (flagsRes.status === 'fulfilled') setInboxFlags(flagsRes.value.flags)
    }).catch(() => {}).finally(() => setAuditLoading(false))
  }, [])

  const [refreshKey, setRefreshKey] = useState(0)
  useUiSse((event) => {
    if (event.type === 'ssot_updated') setRefreshKey(k => k + 1)
    if (event.type === 'ssot_audit_updated') loadAuditData()
  })

  useEffect(() => {
    setLoading(true)
    api.polaris.list()
      .then(data => {
        setProjects(data.projects)
        const paramProject = searchParams.get('project')
        const target = paramProject
          ? data.projects.find(p => p.name === paramProject)
          : data.projects[0]
        if (target) {
          setSelectedName(target.name)
          loadAnnotations(target.name)
        }
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [searchParams, loadAnnotations, refreshKey])

  useEffect(() => {
    loadAuditData()
  }, [loadAuditData])

  useEffect(() => {
    const reqParam = searchParams.get('req')
    if (reqParam) {
      setTimeout(() => {
        const el = document.getElementById(`req-${reqParam}`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' })
          el.classList.remove('ssot-highlight-flash')
          void el.offsetWidth
          el.classList.add('ssot-highlight-flash')
          const onEnd = () => { el.classList.remove('ssot-highlight-flash'); el.removeEventListener('animationend', onEnd) }
          el.addEventListener('animationend', onEnd)
        }
      }, 300)
    }
  }, [searchParams, selectedName])

  const selected = useMemo(
    () => projects.find(p => p.name === selectedName) ?? null,
    [projects, selectedName],
  )

  const handleSave = useCallback((fieldPath: string, newValue: string) => {
    if (!selected) return
    const project = { ...selected }
    const reqs = project.requirements.map(r => ({ ...r, features: [...(r.features ?? [])], blockers: [...(r.blockers ?? [])] }))

    if (fieldPath === 'description') {
      api.polaris.update(project.name, { description: newValue }).catch(() => {})
      return
    }

    const reqMatch = fieldPath.match(/^(R\d+)\.(.+)/)
    if (!reqMatch) return
    const [, reqId, field] = reqMatch
    const req = reqs.find(r => r.id === reqId)
    if (!req || !field) return

    if (field === 'need') req.need = newValue
    else if (field === 'approach') req.approach = newValue
    else if (field === 'technical_details') req.technical_details = newValue
    else {
      const featMatch = field.match(/^features\[(\d+)]\.(\w+)/)
      const blockerMatch = field.match(/^blockers\[(\d+)]/)
      if (featMatch) {
        const idx = parseInt(featMatch[1]!, 10)
        const prop = featMatch[2]!
        if (req.features[idx] && (prop === 'name' || prop === 'description')) {
          req.features[idx] = { ...req.features[idx], [prop]: newValue }
        }
      } else if (blockerMatch) {
        const idx = parseInt(blockerMatch[1]!, 10)
        if (idx < req.blockers.length) req.blockers[idx] = newValue
      }
    }

    api.polaris.update(project.name, { requirements: reqs }).catch(() => {})
  }, [selected])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-zinc-500 text-sm">正在加载 polaris.json...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-4">
          <p className="text-sm text-red-400 font-medium">SSoT 数据加载失败</p>
          <p className="text-xs text-red-300/70 mt-1">{error}</p>
        </div>
      </div>
    )
  }

  if (projects.length === 0) {
    return (
      <div className="p-6">
        <div className="border border-zinc-800 rounded-lg p-8 text-center">
          <p className="text-sm text-zinc-400 mb-2">未找到 polaris.json 文件</p>
          <p className="text-xs text-zinc-600">
            在项目根目录创建 polaris.json 即可开始。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full -mx-6 -mt-2">
      {/* Left: Shared EcoTree sidebar + Topics */}
      <aside className="w-[220px] flex-shrink-0 border-r border-zinc-800 px-2 py-4 max-h-[calc(100vh-80px)] overflow-y-auto sticky top-0">
        <EcoTree />
        <TopicsPanel mode="collect" />
      </aside>

      {/* Right: Document View */}
      <main className="flex-1 overflow-y-auto p-5 min-w-0">
        {/* ─── 审计状态概览 ──────────────────────── */}
        {auditStatus.length > 0 && (
          <div className="mb-5">
            <h2 className="text-sm font-medium text-zinc-300 mb-3">SSoT 审计状态</h2>
            <div className="grid grid-cols-4 gap-3 mb-4">
              <AuditStatCard
                label="Clean"
                count={auditStatus.filter(a => a.severity === 'clean').length}
                color="emerald"
                icon="✓"
              />
              <AuditStatCard
                label="Minor"
                count={auditStatus.filter(a => a.severity === 'minor').length}
                color="amber"
                icon="!"
              />
              <AuditStatCard
                label="Major / Critical"
                count={auditStatus.filter(a => a.severity === 'major' || a.severity === 'critical').length}
                color="red"
                icon="⚠"
              />
              <AuditStatCard
                label="Unknown"
                count={auditStatus.filter(a => a.severity === 'unknown').length}
                color="zinc"
                icon="?"
              />
            </div>
          </div>
        )}

        {/* ─── 未解决告警 ──────────────────────── */}
        {inboxFlags.length > 0 && (
          <div className="mb-5">
            <h3 className="text-sm font-medium text-zinc-300 mb-2">未解决告警 ({inboxFlags.length})</h3>
            <div className="space-y-2">
              {inboxFlags.map(flag => (
                <InboxFlagCard
                  key={flag.id}
                  flag={flag}
                  onViewReport={async (f) => {
                    if (f.id) {
                      try {
                        const report = await api.ssotAudit.getAuditReport(f.id)
                        setSelectedReport(report)
                      } catch {
                        setSelectedReport({ severity: f.severity, project: f.project, findings: f.findings, timestamp: f.timestamp })
                      }
                    }
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {selected ? (
          <ProjectDetail
            project={selected}
            annotations={annotations}
            onAnnotationCreated={() => loadAnnotations(selected.name)}
            onSave={handleSave}
          />
        ) : (
          <p className="text-sm text-zinc-500 text-center py-20">请选择一个项目</p>
        )}
      </main>

      {/* ─── 审计报告详情弹窗 ──────────────────────── */}
      <AuditReportModal report={selectedReport} onClose={() => setSelectedReport(null)} />
    </div>
  )
}
