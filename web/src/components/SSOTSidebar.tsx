import { useEffect, useState, useCallback } from 'react'
import { clsx } from 'clsx'
import { api, type PolarisProject, type PolarisRequirement, type AuditProjectStatus } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import { EcoTree } from './EcoTree'

const STATUS_ICON: Record<string, { dot: string; label: string }> = {
  done:          { dot: 'bg-emerald-500', label: '✓' },
  'in-progress': { dot: 'bg-amber-500',  label: '…' },
  planned:       { dot: 'bg-blue-500',   label: '○' },
  blocked:       { dot: 'bg-red-500',    label: '✗' },
}

function severityDotColor(severity: string): string {
  switch (severity) {
    case 'clean': return 'bg-emerald-500'
    case 'minor': return 'bg-amber-500'
    case 'major': return 'bg-red-500'
    case 'critical': return 'bg-red-500 animate-pulse'
    case 'unknown': return 'bg-zinc-600'
    default: return 'bg-zinc-600'
  }
}

function TreeChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center justify-center w-4 h-4 text-[0.55rem] text-zinc-500 select-none transition-transform duration-100', open && 'rotate-90', className)}>▶</span>
  )
}

function TreeLine({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('ml-[7px] border-l border-zinc-700/60 pl-3', className)}>{children}</div>
}

function CollapsibleText({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="py-0.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors">
        <TreeChevron open={open} />
        <span className="text-xs font-medium">{label}</span>
      </button>
      {open && <div className="ml-[19px] mt-1 text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed border-l border-zinc-700/40 pl-3 py-1">{text}</div>}
    </div>
  )
}

import type { PolarisFeature } from '../lib/api'

function FeatureNode({ feature }: { feature: PolarisFeature }) {
  const [open, setOpen] = useState(false)
  const info = STATUS_ICON[feature.status] ?? { dot: 'bg-zinc-600', label: '?' }

  const hasStructured = (feature.tech?.length ?? 0) > 0 || (feature.interfaces?.length ?? 0) > 0 ||
    (feature.behavior?.length ?? 0) > 0 || (feature.depends_on?.length ?? 0) > 0
  const hasChildren = hasStructured || !!feature.description

  return (
    <div className="py-px" data-feature-name={feature.name}>
      <div
        className={clsx('flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-zinc-800/40', hasChildren && 'cursor-pointer')}
        onClick={hasChildren ? () => setOpen(!open) : undefined}
      >
        {hasChildren ? <TreeChevron open={open} /> : <span className="w-4" />}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${info.dot}`} />
        <span className={clsx('text-[13px] flex-1', feature.status === 'done' ? 'text-zinc-500' : 'text-zinc-200')}>{feature.name}</span>
        <span className="text-[10px] text-zinc-600 font-mono flex-shrink-0">{feature.status}</span>
      </div>
      {open && (
        <TreeLine>
          {feature.tech && feature.tech.length > 0 && (
            <FieldList label="tech" items={feature.tech} />
          )}
          {feature.interfaces && feature.interfaces.length > 0 && (
            <FieldList label="interfaces" items={feature.interfaces} />
          )}
          {feature.behavior && feature.behavior.length > 0 && (
            <FieldList label="behavior" items={feature.behavior} />
          )}
          {feature.depends_on && feature.depends_on.length > 0 && (
            <FieldList label="depends_on" items={feature.depends_on} />
          )}
          {feature.description && !hasStructured && (
            <div className="text-xs text-zinc-400 whitespace-pre-wrap leading-relaxed px-1 py-1">
              {feature.description}
            </div>
          )}
        </TreeLine>
      )}
    </div>
  )
}

function FieldList({ label, items }: { label: string; items: string[] }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="py-px">
      <div className="flex items-center gap-1.5 px-1 py-0.5 cursor-pointer hover:bg-zinc-800/30 rounded" onClick={() => setOpen(!open)}>
        <TreeChevron open={open} />
        <span className="text-[11px] text-zinc-500 font-mono">{label}</span>
        <span className="text-[10px] text-zinc-600 font-mono">({items.length})</span>
      </div>
      {open && (
        <TreeLine>
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-1.5 px-1 py-px">
              <span className="text-zinc-700 text-[10px] mt-0.5 flex-shrink-0">─</span>
              <span className="text-[12px] text-zinc-400">{item}</span>
            </div>
          ))}
        </TreeLine>
      )}
    </div>
  )
}

function ReqTreeNode({
  req, projectName, onInsertRef,
}: {
  req: PolarisRequirement; projectName: string
  onInsertRef?: (projectName: string, reqId: string, label: string) => void
}) {
  const [open, setOpen] = useState(false)
  const features = req.features ?? []
  const blockers = req.blockers ?? []
  const done = features.filter(f => f.status === 'done').length
  const total = features.length
  const allDone = done === total
  const hasBlockers = blockers.length > 0
  const statusKey = allDone ? 'done' : hasBlockers ? 'blocked' : 'in-progress'
  const info = STATUS_ICON[statusKey]!

  return (
    <div
      id={`sidebar-req-${req.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', `[SSoT:${projectName}/${req.id}] ${req.need}`)
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div
        className="flex items-center gap-1.5 py-1 px-1 rounded hover:bg-zinc-800/50 cursor-pointer group"
        onClick={() => setOpen(!open)}
      >
        <TreeChevron open={open} />
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${info.dot}`} />
        <code className="text-xs text-zinc-500 font-mono flex-shrink-0">{req.id}</code>
        <span className="text-[13px] text-zinc-200 flex-1 truncate" title={req.need}>{req.need}</span>
            <span className="text-[10px] text-zinc-600 font-mono tabular-nums flex-shrink-0">{done}/{total}</span>
        {onInsertRef && (
          <button
            onClick={(e) => { e.stopPropagation(); onInsertRef(projectName, req.id, req.need) }}
            className="flex-shrink-0 text-xs px-1 rounded text-hub-text-muted hover:text-hub-accent opacity-0 group-hover:opacity-100 transition-all"
            title="引用"
          >+</button>
        )}
      </div>

      {open && (
        <TreeLine>
          {req.approach && <CollapsibleText label="实现方案" text={req.approach} />}

          {req.tech && Object.keys(req.tech).length > 0 && (
            <div className="py-0.5">
              <div className="flex items-center gap-1 text-zinc-400 px-1 py-0.5">
                <span className="text-[11px] font-mono text-zinc-500">tech</span>
                <span className="text-[10px] text-zinc-600 font-mono">({Object.keys(req.tech).length})</span>
              </div>
              <TreeLine className="ml-0">
                {Object.entries(req.tech).map(([k, v]) => (
                  <div key={k} className="flex items-center gap-2 px-1 py-px">
                    <span className="text-zinc-700 text-[10px] flex-shrink-0">─</span>
                    <span className="text-[12px] text-zinc-300 font-mono">{k}</span>
                    <span className="text-zinc-600 text-[10px]">=</span>
                    <span className="text-[12px] text-zinc-400 font-mono">{v}</span>
                  </div>
                ))}
              </TreeLine>
            </div>
          )}

          {features.length > 0 && (
            <div className="py-0.5">
              <div className="flex items-center gap-1 text-zinc-400 px-1 py-0.5">
                <span className="text-[11px] font-mono text-zinc-500">features</span>
                <span className="text-[10px] text-zinc-600 font-mono">({total})</span>
              </div>
              <TreeLine className="ml-0">
                {features.map((f, i) => (
                  <FeatureNode key={i} feature={f} />
                ))}
              </TreeLine>
            </div>
          )}

          {req.technical_details && <CollapsibleText label="技术描述" text={req.technical_details} />}

          {hasBlockers && (
            <div className="py-0.5 px-1">
              <span className="text-xs font-medium text-red-400/80">阻塞 ({blockers.length})</span>
              <TreeLine className="ml-0">
                {blockers.map((b, i) => <div key={i} className="text-xs text-red-400/70 py-px">⚠ {b}</div>)}
              </TreeLine>
            </div>
          )}
        </TreeLine>
      )}
    </div>
  )
}

function TechStackTree({ tech }: { tech: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="mt-1">
      <div
        className="flex items-center gap-1.5 py-1 px-1 rounded hover:bg-zinc-800/50 cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <TreeChevron open={open} />
        <span className="text-[13px] text-zinc-300 font-medium">技术栈</span>
      </div>
      {open && (
        <TreeLine>
          {Object.entries(tech).map(([cat, items]) => (
            <TechCategoryNode key={cat} name={cat} items={items} />
          ))}
        </TreeLine>
      )}
    </div>
  )
}

function TechCategoryNode({ name, items }: { name: string; items: unknown }) {
  const [open, setOpen] = useState(true)
  const isObject = typeof items === 'object' && items !== null && !Array.isArray(items)

  if (!isObject) {
    return (
      <div className="flex items-center gap-2 px-1 py-0.5">
        <span className="w-4" />
        <span className="text-[13px] text-zinc-300">{name}</span>
        <span className="text-zinc-600 text-xs">=</span>
        <span className="text-[13px] text-zinc-400 font-mono">{String(items)}</span>
      </div>
    )
  }

  const entries = Object.entries(items as Record<string, unknown>)
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-zinc-800/40 cursor-pointer" onClick={() => setOpen(!open)}>
        <TreeChevron open={open} />
        <span className="text-[13px] text-zinc-300">{name}</span>
        <span className="text-[10px] text-zinc-600 font-mono">{entries.length}</span>
      </div>
      {open && (
        <TreeLine>
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 px-1 py-px">
              <span className="w-4" />
              <span className="text-[13px] text-zinc-300 font-mono">{k}</span>
              <span className="text-zinc-600 text-[10px]">=</span>
              <span className="text-[13px] text-zinc-400 font-mono">{String(v)}</span>
            </div>
          ))}
        </TreeLine>
      )}
    </div>
  )
}

interface Props {
  onInsertRef?: (refText: string) => void
  selectedProject?: string
  highlightReq?: { project: string; reqId: string; feature?: string } | null
}

export function SSOTSidebar({ onInsertRef, selectedProject, highlightReq }: Props) {
  const [projects, setProjects] = useState<PolarisProject[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(selectedProject ?? null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [auditStatus, setAuditStatus] = useState<Map<string, AuditProjectStatus>>(new Map())

  const loadAuditStatus = useCallback(() => {
    api.ssotAudit.getAuditStatus()
      .then(data => {
        const map = new Map<string, AuditProjectStatus>()
        for (const p of data.projects) {
          map.set(p.name, p)
        }
        setAuditStatus(map)
      })
      .catch(() => {})
  }, [])

  useUiSse((event) => {
    if (event.type === 'ssot_updated') setRefreshKey(k => k + 1)
    if (event.type === 'ssot_audit_updated') loadAuditStatus()
  })

  useEffect(() => {
    api.polaris.list()
      .then(data => {
        setProjects(data.projects)
        if (!selectedName && data.projects.length > 0) {
          setSelectedName(data.projects[0]!.name)
        }
      })
      .catch(() => {})
    loadAuditStatus()
  }, [refreshKey, loadAuditStatus])

  useEffect(() => {
    if (selectedProject) setSelectedName(selectedProject)
  }, [selectedProject])

  useEffect(() => {
    if (!highlightReq) return
    if (highlightReq.project && highlightReq.project !== selectedName) {
      setSelectedName(highlightReq.project)
    }
    setTimeout(() => {
      let target: HTMLElement | null = null
      if (highlightReq.feature) {
        const reqEl = document.getElementById(`sidebar-req-${highlightReq.reqId}`)
        if (reqEl) {
          const featureEls = reqEl.querySelectorAll<HTMLElement>('[data-feature-name]')
          for (const el of featureEls) {
            if (el.dataset.featureName === highlightReq.feature) { target = el; break }
          }
        }
      }
      if (!target) target = document.getElementById(`sidebar-req-${highlightReq.reqId}`)
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.remove('ssot-highlight-flash')
        void target.offsetWidth
        target.classList.add('ssot-highlight-flash')
        const onEnd = () => { target!.classList.remove('ssot-highlight-flash'); target!.removeEventListener('animationend', onEnd) }
        target.addEventListener('animationend', onEnd)
      }
    }, 100)
  }, [highlightReq])

  const selected = projects.find(p => p.name === selectedName) ?? null

  const handleInsertRef = useCallback((projectName: string, reqId: string, label: string) => {
    onInsertRef?.(`[SSoT:${projectName}/${reqId}] ${label}`)
  }, [onInsertRef])

  const allFeatures = selected?.requirements.flatMap(r => r.features ?? []) ?? []
  const totalFeatures = allFeatures.length
  const doneFeatures = allFeatures.filter(f => f.status === 'done').length

  return (
    <div className="h-full flex flex-col bg-hub-bg">
      <div className="px-4 py-3 border-b border-hub-border flex items-center gap-2 flex-shrink-0">
        <span className="text-base font-semibold text-hub-accent">SSoT</span>
        <span className="text-sm text-hub-text-muted">需求引用</span>
      </div>

      <div className="border-b border-hub-border overflow-y-auto flex-shrink-0 max-h-[40%] px-3 py-2">
        <EcoTree refreshKey={refreshKey} />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-2 py-2">
        {selected ? (
          <div>
            <div className="flex items-center gap-2 px-1 mb-1">
              <span className="text-[13px] font-semibold text-zinc-200">{selected.name}</span>
              {auditStatus.has(selected.name) && (
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${severityDotColor(auditStatus.get(selected.name)!.severity)}`}
                  title={`审计状态: ${auditStatus.get(selected.name)!.severity}`}
                />
              )}
              <span className={clsx(
                'text-[10px] px-1.5 py-0.5 rounded font-mono',
                doneFeatures === totalFeatures ? 'bg-emerald-500/20 text-emerald-400' : 'bg-blue-500/20 text-blue-400',
              )}>
                {doneFeatures}/{totalFeatures}
              </span>
            </div>

            {selected.requirements.map(req => (
              <ReqTreeNode
                key={req.id}
                req={req}
                projectName={selected.name}
                onInsertRef={onInsertRef ? handleInsertRef : undefined}
              />
            ))}

            {selected.tech && <TechStackTree tech={selected.tech} />}
          </div>
        ) : (
          <div className="p-4 text-sm text-zinc-500 italic">
            {projects.length === 0 ? '加载中...' : '从生态树选择项目'}
          </div>
        )}
      </div>
    </div>
  )
}
