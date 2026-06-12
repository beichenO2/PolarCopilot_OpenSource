import { useState, useCallback, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { clsx } from 'clsx'
import { api, type PolarisProject, type SSOTAnnotation } from '../lib/api'

/* ─── Types ──────────────────────────────────────────────── */

interface SSOTNode {
  id: string
  label: string
  type: 'root' | 'tier' | 'project' | 'requirement' | 'feature'
  tier?: string
  status?: string
  projectName?: string
  reqId?: string
  annotationCount?: number
  children?: SSOTNode[]
}

interface Props {
  refreshKey?: number
}

/* ─── Constants ──────────────────────────────────────────── */

const TIER_COLORS: Record<string, string> = {
  infra: 'text-[#bc8cff]',
  knowledge: 'text-hub-accent',
  app: 'text-hub-green',
  domain: 'text-[#d29922]',
}

const STATUS_DOTS: Record<string, string> = {
  done: 'bg-emerald-500', 'in-progress': 'bg-amber-500', planned: 'bg-blue-500',
  blocked: 'bg-red-500', active: 'bg-emerald-500',
}

const TIER_LABELS: Record<string, string> = {
  infra: '基础设施层', knowledge: '知识层', app: '应用层', domain: '业务层',
}

/* ─── Build tree from polaris.json ───────────────────────── */

function buildTree(projects: PolarisProject[], allAnnotations: Map<string, SSOTAnnotation[]>): SSOTNode {
  const tierOrder = ['infra', 'knowledge', 'app', 'domain']
  const tierMap = new Map<string, PolarisProject[]>()
  for (const p of projects) {
    const tier = p.tier || 'other'
    if (!tierMap.has(tier)) tierMap.set(tier, [])
    tierMap.get(tier)!.push(p)
  }

  return {
    id: 'polarisor',
    label: 'Polarisor',
    type: 'root',
    children: [...tierMap.entries()]
      .sort((a, b) => {
        const ai = tierOrder.indexOf(a[0])
        const bi = tierOrder.indexOf(b[0])
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
      })
      .map(([tier, projs]) => ({
        id: `tier-${tier}`,
        label: TIER_LABELS[tier] || tier,
        type: 'tier' as const,
        tier,
        children: projs.map(p => {
          const pAnns = allAnnotations.get(p.name) || []
          const reqChildren = (p.requirements ?? []).map(r => {
            const features = r.features ?? []
            const done = features.filter(f => f.status === 'done').length
            const reqAnns = pAnns.filter(a => a.field_path === r.id)
            const need = r.need ?? ''
            return {
              id: `req-${p.name}-${r.id}`,
              label: need.length > 35 ? need.slice(0, 35) + '…' : need,
              type: 'requirement' as const,
              status: done === features.length ? 'done' : (r.blockers?.length ?? 0) > 0 ? 'blocked' : 'in-progress',
              projectName: p.name,
              reqId: r.id,
              annotationCount: reqAnns.length,
              children: features.map(f => ({
                id: `feat-${p.name}-${r.id}-${f.name}`,
                label: f.name,
                type: 'feature' as const,
                status: f.status,
                projectName: p.name,
                reqId: r.id,
              })),
            }
          })
          const totalAnnCount = reqChildren.reduce((sum, c) => sum + (c.annotationCount ?? 0), 0)
          return {
            id: `proj-${p.name}`,
            label: p.name,
            type: 'project' as const,
            tier: p.tier,
            status: p.status,
            projectName: p.name,
            annotationCount: totalAnnCount,
            children: reqChildren,
          }
        }),
      })),
  }
}

/* ─── Tree Component ─────────────────────────────────────── */

export function EcoTree({ refreshKey }: Props) {
  const [projects, setProjects] = useState<PolarisProject[]>([])
  const [allAnnotations, setAllAnnotations] = useState<Map<string, SSOTAnnotation[]>>(new Map())

  const fetchData = useCallback(async () => {
    try {
      const data = await api.polaris.list()
      setProjects(data.projects)
      const annMap = new Map<string, SSOTAnnotation[]>()
      for (const p of data.projects) {
        try {
          const d = await api.polaris.annotations(p.name)
          if (d.annotations.length > 0) annMap.set(p.name, d.annotations)
        } catch { /* ignore */ }
      }
      setAllAnnotations(annMap)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetchData()
    const iv = setInterval(fetchData, 30000)
    return () => clearInterval(iv)
  }, [fetchData])

  useEffect(() => {
    if (refreshKey) fetchData()
  }, [refreshKey, fetchData])

  const tree = useMemo(() => buildTree(projects, allAnnotations), [projects, allAnnotations])

  if (projects.length === 0) {
    return <div className="text-xs text-hub-text-muted italic py-2">加载 SSoT...</div>
  }

  return (
    <div className="text-sm select-none">
      <TreeNodeView
        node={tree}
        depth={0}
        defaultExpanded
      />
    </div>
  )
}

function TreeNodeView({
  node, depth, defaultExpanded,
}: {
  node: SSOTNode; depth: number
  defaultExpanded?: boolean
}) {
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 2)
  const hasChildren = (node.children?.length ?? 0) > 0

  const handleClick = useCallback(() => {
    if (node.type === 'project' || node.type === 'requirement') {
      navigate(`/ssot?project=${node.projectName}${node.reqId ? `&req=${node.reqId}` : ''}`)
    } else if (hasChildren) {
      setExpanded(prev => !prev)
    }
  }, [navigate, node.type, node.projectName, node.reqId, hasChildren])

  const handleChevronClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded(prev => !prev)
  }, [])

  const annCount = node.annotationCount ?? 0
  const isDraggable = annCount > 0 && (node.type === 'project' || node.type === 'requirement')

  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (annCount === 0) { e.preventDefault(); return }
    if (node.type === 'project' && node.children?.length) {
      const refs = (node.children ?? [])
        .filter(c => (c.annotationCount ?? 0) > 0)
        .map(c => `[SSoT:${node.projectName}/${c.reqId}] ${c.label}`)
      e.dataTransfer.setData('text/plain', refs.join('\n'))
      e.dataTransfer.setData('application/x-ssot-project', node.projectName ?? '')
      const childReqIds = node.children
        .filter(c => (c.annotationCount ?? 0) > 0)
        .map(c => c.reqId ?? '')
        .filter(Boolean)
      e.dataTransfer.setData('application/x-ssot-field-paths', childReqIds.join(','))
    } else {
      const ref = node.reqId
        ? `[SSoT:${node.projectName}/${node.reqId}] ${node.label}`
        : node.projectName
          ? `[SSoT:${node.projectName}] ${node.label}`
          : node.label
      e.dataTransfer.setData('text/plain', ref)
      if (node.reqId && node.projectName) {
        e.dataTransfer.setData('application/x-ssot-project', node.projectName)
        e.dataTransfer.setData('application/x-ssot-field-paths', node.reqId)
      }
    }
    e.dataTransfer.effectAllowed = 'copy'
  }, [node, annCount])

  const indent = depth * 14

  return (
    <div>
      <div
        onClick={handleClick}
        draggable={isDraggable}
        onDragStart={isDraggable ? handleDragStart : undefined}
        style={{ paddingLeft: indent + 8 }}
        className={clsx(
          'flex items-center gap-1.5 py-1 px-1 rounded-md cursor-pointer transition-colors text-sm leading-tight',
          'hover:bg-[#21262d] text-hub-text',
          node.type === 'tier' && 'mt-1',
          isDraggable && 'cursor-grab active:cursor-grabbing',
        )}
        title={isDraggable
          ? `点击跳转 · 拖拽引用（${annCount} 条批注）`
          : node.type === 'project' || node.type === 'requirement'
            ? '点击跳转'
            : undefined}
      >
        {hasChildren ? (
          <span
            onClick={handleChevronClick}
            className={clsx(
              'w-4 h-4 flex items-center justify-center text-xs text-hub-text-muted flex-shrink-0 transition-transform hover:text-hub-text',
              expanded && 'rotate-90',
            )}
          >▶</span>
        ) : (
          <span className="w-3.5 flex-shrink-0" />
        )}

        {node.status && (
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOTS[node.status] ?? 'bg-zinc-600'}`} />
        )}

        {node.type === 'tier' ? (
          <span className={clsx('font-semibold text-xs uppercase tracking-wider', TIER_COLORS[node.tier!])}>
            {node.label}
          </span>
        ) : node.type === 'root' ? (
          <span className="font-bold text-sm">{node.label}</span>
        ) : (
          <span className={clsx('truncate', node.type === 'project' && 'font-medium')} title={node.label}>
            {node.label}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1">
          {annCount > 0 && (
            <span className="flex-shrink-0 bg-blue-500/20 text-blue-400 text-xs font-bold px-1.5 py-px rounded-full min-w-[16px] text-center" title={`${annCount} 条批注`}>
              {annCount}
            </span>
          )}
        </span>
      </div>

      {expanded && hasChildren && (
        <div>
          {node.children!.map(child => (
            <TreeNodeView
              key={child.id}
              node={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ─── Re-export helpers for PromptsPage ──────────────────── */

export function findNodeById(root: SSOTNode, id: string): SSOTNode | null {
  if (root.id === id) return root
  for (const child of root.children ?? []) {
    const found = findNodeById(child, id)
    if (found) return found
  }
  return null
}

export function getNodeBreadcrumb(root: SSOTNode, targetId: string): SSOTNode[] {
  const path: SSOTNode[] = []
  function walk(node: SSOTNode): boolean {
    path.push(node)
    if (node.id === targetId) return true
    for (const child of node.children ?? []) { if (walk(child)) return true }
    path.pop()
    return false
  }
  walk(root)
  return path
}
