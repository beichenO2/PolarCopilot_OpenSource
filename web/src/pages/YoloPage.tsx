import { useEffect, useState, useCallback, useRef } from 'react'
import { clsx } from 'clsx'
import { renderMarkdown } from '../lib/markdown'
import { api } from '../lib/api'
import { useUiSse } from '../lib/useUiSse'
import type { AlignmentDoc } from '../lib/api'
import type { Agent, Prompt } from '../types/hub'
import { optionLabel } from '../types/hub'
import { ResizableSplitPane } from '../components/ResizableSplitPane'
import { HistoryPanel } from '../components/HistoryPanel'

const YOLO_MARKERS = ['YOLO 方案', 'YOLO方案', 'YOLO 对齐方案', '确认，开始 YOLO', 'yolo_plan', 'YOLO 进度', 'YOLO 执行完成']

const ALIGNMENT_SECTION_NAMES = ['极限目标', '工作逻辑', '用户预期体验', '执行计划', '质量标准', '工作流测试矩阵', '风险']

function isYoloPlan(p: Prompt): boolean {
  if (p.prompt && YOLO_MARKERS.some((m) => (p.prompt ?? '').includes(m))) return true
  if (p.options?.some((o) => optionLabel(o).includes('YOLO'))) return true
  return false
}

function computeLineDiff(original: string, edited: string): string[] {
  const origLines = original.split('\n')
  const editLines = edited.split('\n')
  const diffs: string[] = []
  const maxLen = Math.max(origLines.length, editLines.length)
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i] ?? ''
    const e = editLines[i] ?? ''
    if (o !== e) {
      if (o && e) diffs.push(`L${i + 1}: "${o.trim()}" → "${e.trim()}"`)
      else if (!o) diffs.push(`L${i + 1}+ "${e.trim()}"`)
      else diffs.push(`L${i + 1}- "${o.trim()}"`)
    }
  }
  return diffs
}

const STATUS_STYLES: Record<string, { text: string; color: string }> = {
  draft: { text: '草稿', color: 'bg-[#484f58]/30 text-hub-text-muted border-[#484f58]/40' },
  pending_review: { text: '待审核', color: 'bg-hub-orange/20 text-hub-orange border-hub-orange/30' },
  approved: { text: '已批准', color: 'bg-hub-green/20 text-hub-green border-hub-green/30' },
  rejected: { text: '需修改', color: 'bg-hub-red/20 text-hub-red border-hub-red/30' },
  executing: { text: '执行中', color: 'bg-hub-accent/20 text-hub-accent border-hub-accent/30' },
  completed: { text: '已完成', color: 'bg-hub-green/20 text-hub-green border-hub-green/30' },
}

interface DocAnnotation {
  id: string
  text: string
  note: string
}

function YoloHistoryCard({ type, doc, prompt }: { type: 'doc' | 'prompt'; doc?: AlignmentDoc; prompt?: Prompt }) {
  const [open, setOpen] = useState(false)

  if (type === 'doc' && doc) {
    const statusInfo = STATUS_STYLES[doc.status] ?? STATUS_STYLES.draft!
    const time = new Date(doc.created_at).toLocaleString('zh', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const firstLine = doc.goal || (doc.plan_markdown ?? '').split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) || '对齐文档'

    return (
      <div className="bg-hub-surface border border-[#21262d] rounded-[10px] px-[18px] py-3.5 opacity-70 hover:opacity-90 transition-opacity">
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => setOpen(!open)}>
          {!open && (
            <span className="text-[0.85rem] text-hub-text overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
              {firstLine}
            </span>
          )}
          {open && <span className="flex-1" />}
          <div className="flex items-center gap-3 flex-shrink-0 text-[0.7rem] text-[#484f58]">
            <span>{time}</span>
            <span className={clsx('px-1.5 py-0.5 rounded-full border text-[0.6rem] font-medium', statusInfo!.color)}>
              {statusInfo!.text}
            </span>
          </div>
          <span className={`text-[0.7rem] text-[#484f58] flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
        </div>
        {open && (
          <div className="mt-2.5 pt-2.5 border-t border-[#21262d] select-text">
            {doc.goal && <p className="text-xs text-hub-orange font-medium mb-1.5">极限目标: {doc.goal}</p>}
            <div
              className="text-[0.9rem] leading-relaxed text-hub-text markdown-body"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.plan_markdown ?? '') }}
            />
          </div>
        )}
      </div>
    )
  }

  if (type === 'prompt' && prompt) {
    const agentLabel = prompt.display_name || prompt.agent_id || 'system'
    const firstLine = ((prompt.prompt ?? '').split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, 100)
    const answerPreview = (prompt.answer || '').slice(0, 60)

    return (
      <div className="bg-hub-surface border border-[#21262d] rounded-[10px] px-[18px] py-3.5 opacity-70 hover:opacity-90 transition-opacity">
        <div className="flex items-center gap-2.5 cursor-pointer" onClick={() => setOpen(!open)}>
          {!open && (
            <span className="text-[0.85rem] text-hub-text overflow-hidden text-ellipsis whitespace-nowrap flex-1 min-w-0">
              {firstLine}
            </span>
          )}
          {open && <span className="flex-1" />}
          <div className="flex items-center gap-3 flex-shrink-0 text-[0.7rem] text-[#484f58]">
            <span>{new Date(prompt.created_at).toLocaleTimeString()}</span>
            <span>{agentLabel}</span>
            {answerPreview && <span className="text-hub-green font-medium">{answerPreview}{(prompt.answer || '').length > 60 ? '...' : ''}</span>}
          </div>
          <span className={`text-[0.7rem] text-[#484f58] flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>▼</span>
        </div>
        {open && (
          <div className="mt-2.5 pt-2.5 border-t border-[#21262d] select-text">
            <div
              className="text-[0.9rem] leading-relaxed text-hub-text markdown-body mb-3"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.prompt ?? '') }}
            />
            {prompt.answer && (
              <div className="mt-2 pt-2 border-t border-[#21262d]">
                <span className="text-[0.7rem] text-[#484f58]">回复: </span>
                <span className="text-[0.85rem] text-hub-green font-medium whitespace-pre-wrap break-words">{prompt.answer}</span>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return null
}

export function YoloPage() {
  const [docs, setDocs] = useState<AlignmentDoc[]>([])
  const [pending, setPending] = useState<Prompt[]>([])
  const [history, setHistory] = useState<Prompt[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [selectedDoc, setSelectedDoc] = useState<AlignmentDoc | null>(null)

  // Inline editing state
  const [editingDocId, setEditingDocId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState('')
  const [editOriginal, setEditOriginal] = useState('')
  const [editGoal, setEditGoal] = useState('')
  const [editGoalOriginal, setEditGoalOriginal] = useState('')
  const [saving, setSaving] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)

  // Prompt view state
  const [modifyId, setModifyId] = useState<string | null>(null)
  const [modifyText, setModifyText] = useState('')
  const [yoloInput, setYoloInput] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Error feedback state
  const [approveError, setApproveError] = useState<{ docId: string; message: string } | null>(null)

  // Annotation state for alignment docs
  const [docAnnotations, setDocAnnotations] = useState<Record<string, DocAnnotation[]>>({})
  const [annotating, setAnnotating] = useState<{ docId: string; text: string } | null>(null)
  const [annotationNote, setAnnotationNote] = useState('')

  const handleDocTextSelect = useCallback((docId: string, containerRef: HTMLDivElement | null) => {
    if (!containerRef) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!containerRef.contains(range.commonAncestorContainer)) return
    const text = sel.toString().trim()
    if (text.length > 0) {
      setAnnotating({ docId, text })
      setAnnotationNote('')
    }
  }, [])

  const addDocAnnotation = useCallback(() => {
    if (!annotating || !annotationNote.trim()) return
    setDocAnnotations(prev => ({
      ...prev,
      [annotating.docId]: [
        ...(prev[annotating.docId] ?? []),
        { id: `ann-${Date.now()}`, text: annotating.text, note: annotationNote.trim() },
      ],
    }))
    setAnnotating(null)
    setAnnotationNote('')
    window.getSelection()?.removeAllRanges()
  }, [annotating, annotationNote])

  const sendDocAnnotations = useCallback(async (docId: string, agentId: string) => {
    const anns = docAnnotations[docId]
    if (!anns?.length) return
    const parts = anns.map((a, i) => `【批注 ${i + 1}】"${a.text}"\n→ ${a.note}`)
    const answer = `对齐方案批注:\n\n${parts.join('\n\n')}`

    const pendingAll = await api.prompts.pending()
    const agentPrompt = pendingAll.find(p => p.agent_id === agentId && !p.answered)
    if (agentPrompt) {
      await api.prompts.answer(agentPrompt.id, answer)
    }
    setDocAnnotations(prev => { const next = { ...prev }; delete next[docId]; return next })
    await load()
  }, [docAnnotations])

  const load = useCallback(async () => {
    try {
      const [alignDocs, p, h, ag] = await Promise.all([
        api.alignment.list().catch(() => [] as AlignmentDoc[]),
        api.prompts.pending(),
        api.prompts.history(100),
        api.agents.list(),
      ])
      setDocs([...alignDocs].reverse())
      setPending(p.filter(isYoloPlan))
      setHistory(h.filter(isYoloPlan))
      setAgents(ag.filter((a) => a.alive))

      if (alignDocs.length > 0 && !selectedDoc) {
        const active = alignDocs.find((d) => d.status !== 'completed') || alignDocs[0]
        if (active) setSelectedDoc(active)
      }
    } catch { /* ignore */ }
  }, [selectedDoc])

  useUiSse(useCallback(() => { load() }, [load]))

  useEffect(() => {
    load()
    const iv = setInterval(load, 15000)
    return () => clearInterval(iv)
  }, [load])

  const handleAnswer = async (id: string, answer: string) => {
    await api.prompts.answer(id, answer)
    await load()
  }

  const handleSendModify = async (id: string) => {
    if (!modifyText.trim()) return
    await api.prompts.answer(id, `需要修改: ${modifyText.trim()}`)
    setModifyId(null)
    setModifyText('')
    await load()
  }

  const handleStartYolo = async () => {
    if (!yoloInput.trim() || sending) return
    setSending(true)
    try {
      const pendingAll = await api.prompts.pending()
      const activePending = pendingAll.find((p) => !p.answered)
      if (activePending) {
        await api.prompts.answer(activePending.id, `YOLO模式 ${yoloInput.trim()}`)
      } else {
        const firstAgent = agents[0]
        if (firstAgent) {
          await api.alignment.create({
            agent_id: firstAgent.agent_id,
            goal: yoloInput.trim(),
            work_logic: 'Debug > Test > Dev',
            sections: [
              { name: '极限目标', confirmed: false },
              { name: '工作逻辑', confirmed: false },
              { name: '用户预期体验', confirmed: false },
              { name: '执行计划', confirmed: false },
              { name: '质量标准', confirmed: false },
              { name: '工作流测试矩阵', confirmed: false },
              { name: '风险', confirmed: false },
            ],
          } as Parameters<typeof api.alignment.create>[0])
        }
      }
      setYoloInput('')
      await load()
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? ''
      setApproveError({ docId: 'start', message: msg || 'YOLO 发起失败' })
    }
    setSending(false)
  }

  const handleConfirmSection = async (docId: string, sectionName: string, confirmed: boolean) => {
    try {
      await api.alignment.confirmSection(docId, sectionName, confirmed)
      const updated = await api.alignment.get(docId)
      setSelectedDoc(updated)
      await load()
    } catch { /* ignore */ }
  }

  const handleApprove = async (docId: string, force = false) => {
    setApproveError(null)
    try {
      await api.alignment.approve(docId, force)
      await load()
    } catch (err: unknown) {
      const resp = err as { message?: string }
      const msg = resp?.message ?? ''
      if (msg.includes('not all sections confirmed')) {
        setApproveError({ docId, message: '请先勾选所有对齐项后再确认' })
      } else if (msg.includes('coverage')) {
        setApproveError({ docId, message: '对齐覆盖率不足，请补充方案内容后再确认' })
      } else {
        setApproveError({ docId, message: msg || '确认失败，请检查对齐方案' })
      }
    }
  }

  const startEditing = (doc: AlignmentDoc) => {
    setEditingDocId(doc.id)
    setEditBuffer(doc.plan_markdown)
    setEditOriginal(doc.plan_markdown)
    setEditGoal(doc.goal)
    setEditGoalOriginal(doc.goal)
    setTimeout(() => editorRef.current?.focus(), 50)
  }

  const cancelEditing = () => {
    setEditingDocId(null)
    setEditBuffer('')
    setEditOriginal('')
    setEditGoal('')
    setEditGoalOriginal('')
  }

  const saveEdits = async (doc: AlignmentDoc) => {
    if (saving) return
    const planChanged = editBuffer !== editOriginal
    const goalChanged = editGoal !== editGoalOriginal
    if (!planChanged && !goalChanged) {
      cancelEditing()
      return
    }

    setSaving(true)
    try {
      const planDiffs = planChanged ? computeLineDiff(editOriginal, editBuffer) : []
      const goalDiff = goalChanged ? `极限目标: "${editGoalOriginal}" → "${editGoal}"` : null

      const updatePayload: Record<string, unknown> = { changed_by: 'user' }
      if (planChanged) updatePayload.plan_markdown = editBuffer
      if (goalChanged) updatePayload.goal = editGoal

      await api.alignment.update(doc.id, updatePayload as Parameters<typeof api.alignment.update>[1])

      const diffSummary = [
        goalDiff,
        ...planDiffs.slice(0, 20),
        planDiffs.length > 20 ? `...还有 ${planDiffs.length - 20} 处修改` : null,
      ].filter(Boolean).join('\n')

      const pendingAll = await api.prompts.pending()
      const agentPrompt = pendingAll.find((p) => p.agent_id === doc.agent_id && !p.answered)
      if (agentPrompt) {
        await api.prompts.answer(agentPrompt.id, `用户直接编辑了对齐方案:\n${diffSummary}`)
      }

      cancelEditing()
      await load()
    } catch { /* ignore */ }
    setSaving(false)
  }

  const isEditing = (docId: string) => editingDocId === docId
  const hasEdits = editBuffer !== editOriginal || editGoal !== editGoalOriginal
  const canEdit = (doc: AlignmentDoc) => doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'rejected'

  const renderSectionChecklist = (doc: AlignmentDoc) => {
    const sectionsArr = Array.isArray(doc.sections) ? doc.sections : []
    const existingSections = new Map(sectionsArr.map((s) => [s.name, s]))
    const md = isEditing(doc.id) ? editBuffer : (doc.plan_markdown ?? '')
    const sectionNames = sectionsArr.length > 0
      ? [...new Set([...sectionsArr.map(s => s.name), ...ALIGNMENT_SECTION_NAMES])]
      : ALIGNMENT_SECTION_NAMES
    const allSections = sectionNames.map((name) => {
      const existing = existingSections.get(name)
      const present = md.includes(name)
      return { name, confirmed: existing?.confirmed ?? false, comment: existing?.comment, present }
    })
    const confirmedCount = allSections.filter((s) => s.confirmed).length

    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-hub-text-muted">对齐检查 ({confirmedCount}/{allSections.length})</p>
          {confirmedCount === allSections.length && doc.status !== 'approved' && doc.status !== 'executing' && doc.status !== 'completed' && (
            <button
              onClick={() => handleApprove(doc.id)}
              className="px-3 py-1 text-xs rounded-lg bg-hub-green/80 text-white hover:bg-hub-green transition-colors font-medium"
            >
              全部确认，开始 YOLO
            </button>
          )}
        </div>
        {approveError?.docId === doc.id && (
          <p className="text-xs text-hub-red mt-1">{approveError.message}</p>
        )}
        <div className="space-y-1.5">
          {allSections.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <button
                onClick={() => handleConfirmSection(doc.id, s.name, !s.confirmed)}
                disabled={doc.status === 'approved' || doc.status === 'executing' || doc.status === 'completed'}
                className={clsx(
                  'w-5 h-5 rounded border flex items-center justify-center text-xs transition-colors',
                  s.confirmed
                    ? 'bg-hub-green/20 border-hub-green/40 text-hub-green'
                    : 'border-hub-border hover:border-hub-accent',
                  (doc.status === 'approved' || doc.status === 'executing' || doc.status === 'completed') && 'opacity-60 cursor-not-allowed',
                )}
              >
                {s.confirmed ? '✓' : ''}
              </button>
              <span className={clsx(
                'text-sm',
                s.present ? 'text-hub-text' : 'text-hub-text-muted',
              )}>
                {s.name}
              </span>
              {!s.present && (
                <span className="text-xs text-hub-text-muted italic">未覆盖</span>
              )}
            </div>
          ))}
        </div>
      </div>
    )
  }

  const renderAlignmentDoc = (doc: AlignmentDoc) => {
    const statusInfo = STATUS_STYLES[doc.status] ?? STATUS_STYLES.draft!
    const time = new Date(doc.created_at).toLocaleString('zh', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    const editing = isEditing(doc.id)

    return (
      <div key={doc.id} className="bg-hub-surface border border-hub-border rounded-xl overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-hub-border flex items-center gap-3">
          <span className={clsx('text-xs px-2 py-0.5 rounded-full border font-medium', statusInfo!.color)}>
            {statusInfo!.text}
          </span>
          <span className="text-sm text-hub-accent font-medium">{doc.agent_id}</span>
          <span className="text-xs text-hub-text-muted">v{doc.version}</span>
          {editing && hasEdits && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-hub-orange/20 text-hub-orange border border-hub-orange/30 font-medium">
              已修改
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {canEdit(doc) && !editing && (
              <button
                onClick={() => startEditing(doc)}
                className="text-xs px-2.5 py-1 rounded-lg border border-hub-border text-hub-text-muted hover:text-hub-accent hover:border-hub-accent transition-colors"
              >
                编辑方案
              </button>
            )}
            <span className="text-xs text-hub-text-muted">{time}</span>
          </span>
        </div>

        {/* Goal section */}
        {editing ? (
          <div className="px-5 py-3 border-b border-hub-border bg-hub-bg/50">
            <p className="text-xs text-hub-orange font-medium mb-1.5">极限目标</p>
            <input
              type="text"
              value={editGoal}
              onChange={(e) => setEditGoal(e.target.value)}
              className="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text focus:outline-none focus:border-hub-orange transition-[border-color]"
            />
            {editGoal !== editGoalOriginal && (
              <p className="text-xs text-hub-orange/60 mt-1">
                原: {editGoalOriginal}
              </p>
            )}
          </div>
        ) : doc.goal ? (
          <div className="px-5 py-3 border-b border-hub-border bg-hub-bg/50">
            <p className="text-xs text-hub-orange font-medium mb-1">极限目标</p>
            <p className="text-sm text-hub-text">{doc.goal}</p>
          </div>
        ) : null}

        {/* Plan content: edit or render */}
        {editing ? (
          <div className="px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-hub-text-muted">Markdown 编辑（直接修改方案，保存后 diff 自动发送给 Agent）</p>
              <span className="text-xs text-hub-text-muted font-mono">{editBuffer.split('\n').length} 行</span>
            </div>
            <textarea
              ref={editorRef}
              value={editBuffer}
              onChange={(e) => setEditBuffer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  saveEdits(doc)
                }
                if (e.key === 'Escape') {
                  cancelEditing()
                }
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
              onDrop={(e) => {
                e.preventDefault()
                const text = e.dataTransfer.getData('text/plain')?.trim()
                if (!text) return
                const pos = e.currentTarget.selectionStart ?? editBuffer.length
                const before = editBuffer.slice(0, pos)
                const after = editBuffer.slice(pos)
                setEditBuffer(`${before}\n\n> ${text}\n\n${after}`)
              }}
              className="w-full bg-hub-bg border border-hub-border rounded-lg px-4 py-3 text-sm text-hub-text font-mono leading-relaxed resize-y min-h-[600px] focus:outline-none focus:border-hub-orange transition-[border-color]"
              style={{ tabSize: 2 }}
            />
            {hasEdits && (
              <div className="mt-2 p-3 bg-hub-bg/80 border border-hub-border rounded-lg">
                <p className="text-xs text-hub-orange font-medium mb-1">修改预览</p>
                <div className="text-xs text-hub-text-muted space-y-0.5 max-h-32 overflow-y-auto">
                  {editGoal !== editGoalOriginal && (
                    <p className="text-hub-orange">极限目标: &quot;{editGoalOriginal}&quot; → &quot;{editGoal}&quot;</p>
                  )}
                  {computeLineDiff(editOriginal, editBuffer).slice(0, 10).map((d, i) => (
                    <p key={i} className={d.includes('→') ? 'text-hub-orange' : d.includes('+') ? 'text-hub-green' : 'text-hub-red'}>
                      {d}
                    </p>
                  ))}
                  {computeLineDiff(editOriginal, editBuffer).length > 10 && (
                    <p className="text-hub-text-muted">...还有 {computeLineDiff(editOriginal, editBuffer).length - 10} 处修改</p>
                  )}
                </div>
              </div>
            )}
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => saveEdits(doc)}
                disabled={saving || !hasEdits}
                className="px-4 py-2 text-sm rounded-lg bg-hub-orange/80 text-white hover:bg-hub-orange disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {saving ? '保存中...' : '保存修改 (⌘S)'}
              </button>
              <button
                onClick={cancelEditing}
                className="px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-text-muted border border-hub-border hover:border-hub-accent transition-colors"
              >
                取消 (Esc)
              </button>
              {hasEdits && (
                <button
                  onClick={() => { setEditBuffer(editOriginal); setEditGoal(editGoalOriginal) }}
                  className="px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-red border border-hub-red/30 hover:bg-hub-red/10 transition-colors"
                >
                  还原
                </button>
              )}
            </div>
          </div>
        ) : (doc.plan_markdown ?? '').length > 0 ? (
          <>
            <div className="px-5 pt-1 flex items-center justify-end">
              <span className="text-[0.65rem] text-[#484f58] select-none">选中文字可批注</span>
            </div>
            <div
              onMouseUp={() => handleDocTextSelect(doc.id, document.getElementById(`doc-content-${doc.id}`) as HTMLDivElement)}
              id={`doc-content-${doc.id}`}
              className="px-5 py-4 text-sm leading-relaxed markdown-body [&_h1]:text-hub-orange [&_h2]:text-hub-orange [&_h3]:text-hub-orange [&_code]:text-hub-orange [&_th]:text-hub-orange"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.plan_markdown ?? '') }}
            />

            {/* Annotation popover for doc */}
            {annotating?.docId === doc.id && (
              <div className="mx-5 mb-3 bg-[#161b22] border border-hub-orange rounded-lg p-3 space-y-2">
                <div className="text-xs text-hub-text-muted">批注选中内容：</div>
                <div className="text-sm text-hub-orange bg-[#1f3d5a]/30 rounded px-2 py-1 line-clamp-2">
                  "{annotating.text}"
                </div>
                <div className="flex gap-2 items-end">
                  <textarea
                    value={annotationNote}
                    onChange={(e) => setAnnotationNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addDocAnnotation() }
                      if (e.key === 'Escape') { setAnnotating(null); setAnnotationNote('') }
                    }}
                    placeholder="写下你的批注... (⌘+Enter 添加, Esc 取消)"
                    rows={1}
                    autoFocus
                    className="flex-1 bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text placeholder:text-hub-text-muted font-inherit leading-[1.5] focus:outline-none focus:border-hub-orange transition-[border-color] resize-none"
                  />
                  <button
                    onClick={addDocAnnotation}
                    disabled={!annotationNote.trim()}
                    className="px-3 py-2 text-sm rounded-lg border border-hub-orange bg-hub-orange/20 text-hub-orange hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity whitespace-nowrap"
                  >
                    添加
                  </button>
                  <button
                    onClick={() => { setAnnotating(null); setAnnotationNote('') }}
                    className="px-3 py-2 text-sm rounded-lg border border-hub-border text-hub-text-muted hover:text-hub-text transition-colors"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}

            {/* Doc annotations list */}
            {(docAnnotations[doc.id]?.length ?? 0) > 0 && (
              <div className="mx-5 mb-3 bg-[#161b22] border border-[#30363d] rounded-lg p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-hub-text-muted">方案批注 ({docAnnotations[doc.id]!.length})</span>
                  <button
                    onClick={() => sendDocAnnotations(doc.id, doc.agent_id)}
                    className="text-xs px-3 py-1 rounded-md border border-hub-orange bg-hub-orange/20 text-hub-orange hover:opacity-85 transition-opacity"
                  >
                    发送全部批注给 Agent
                  </button>
                </div>
                {docAnnotations[doc.id]!.map((a, i) => (
                  <div key={a.id} className="flex gap-2 items-start text-sm border-t border-[#21262d] pt-2">
                    <span className="text-hub-orange flex-shrink-0 text-xs mt-0.5">#{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-hub-text-muted text-xs line-clamp-1">"{a.text}"</div>
                      <div className="text-hub-text mt-0.5">{a.note}</div>
                    </div>
                    <button
                      onClick={() => setDocAnnotations(prev => ({
                        ...prev,
                        [doc.id]: prev[doc.id]?.filter(x => x.id !== a.id) ?? [],
                      }))}
                      className="text-hub-text-muted hover:text-hub-red text-xs flex-shrink-0"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        <div className="px-5 py-3 border-t border-hub-border">
          {renderSectionChecklist(doc)}
        </div>

        {!editing && (doc.status === 'pending_review' || doc.status === 'draft') && (
          <div className="px-5 py-3 border-t border-hub-border">
            {approveError?.docId === doc.id && (
              <div className="mb-2.5 px-3 py-2 rounded-lg bg-hub-red/10 border border-hub-red/30 text-sm text-hub-red">
                {approveError.message}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => handleApprove(doc.id)}
                className="px-4 py-2 text-sm rounded-lg bg-hub-green/80 text-white hover:bg-hub-green transition-colors font-medium"
              >
                确认，开始 YOLO
              </button>
              <button
                onClick={() => startEditing(doc)}
                className="px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-orange border border-hub-orange/30 hover:bg-hub-orange/10 transition-colors"
              >
                编辑方案
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderPromptPlan = (p: Prompt, isPending: boolean) => {
    let statusEl: React.ReactNode
    if (!p.answered) {
      statusEl = <span className="text-xs px-2 py-0.5 rounded-full bg-hub-orange/20 text-hub-orange border border-hub-orange/30 font-medium">待审核</span>
    } else if (p.answer?.includes('YOLO')) {
      statusEl = <span className="text-xs px-2 py-0.5 rounded-full bg-hub-green/20 text-hub-green border border-hub-green/30 font-medium">已批准</span>
    } else if (p.answer?.includes('取消')) {
      statusEl = <span className="text-xs px-2 py-0.5 rounded-full bg-hub-red/20 text-hub-red border border-hub-red/30 font-medium">已取消</span>
    } else {
      statusEl = <span className="text-xs px-2 py-0.5 rounded-full bg-[#484f58]/30 text-hub-text-muted border border-[#484f58]/40 font-medium">已处理</span>
    }

    const displayName = p.display_name || p.agent_id || 'unknown'
    const time = new Date(p.created_at).toLocaleString('zh', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

    return (
      <div key={p.id} className="bg-hub-surface border border-hub-border rounded-xl overflow-hidden mb-5">
        <div className="px-5 py-3 border-b border-hub-border flex items-center gap-3">
          {statusEl}
          <span className="text-sm text-hub-accent font-medium">{displayName}</span>
          <span className="ml-auto text-xs text-hub-text-muted">{time}</span>
        </div>
        <div
          className="px-5 py-4 text-sm leading-relaxed markdown-body [&_h1]:text-hub-orange [&_h2]:text-hub-orange [&_h3]:text-hub-orange [&_code]:text-hub-orange [&_th]:text-hub-orange"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(p.prompt ?? '') }}
        />

        {isPending && !p.answered && (
          <>
            <div className="px-5 py-3 border-t border-hub-border flex gap-2">
              <button
                onClick={() => handleAnswer(p.id, '确认，开始 YOLO')}
                className="px-4 py-2 text-sm rounded-lg bg-hub-green/80 text-white hover:bg-hub-green transition-colors font-medium"
              >
                确认，开始 YOLO
              </button>
              <button
                onClick={() => setModifyId(modifyId === p.id ? null : p.id)}
                className="px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-orange border border-hub-orange/30 hover:bg-hub-orange/10 transition-colors"
              >
                需要修改
              </button>
              <button
                onClick={() => handleAnswer(p.id, '取消')}
                className="px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-red border border-hub-red/30 hover:bg-hub-red/10 transition-colors"
              >
                取消
              </button>
            </div>

            {modifyId === p.id && (
              <div className="px-5 pb-3 border-t border-hub-border pt-3">
                <textarea
                  value={modifyText}
                  onChange={(e) => setModifyText(e.target.value)}
                  placeholder="描述需要修改的内容..."
                  rows={3}
                  className="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2 text-sm text-hub-text resize-y focus:outline-none focus:border-hub-accent"
                />
                <button
                  onClick={() => handleSendModify(p.id)}
                  className="mt-2 px-4 py-2 text-sm rounded-lg bg-hub-surface text-hub-orange border border-hub-orange/30 hover:bg-hub-orange/10 transition-colors"
                >
                  发送修改意见
                </button>
              </div>
            )}
          </>
        )}

        {p.answered && p.answer && !p.answer.startsWith('[') && (
          <div className="px-5 py-3 border-t border-hub-border">
            <span className="text-xs text-hub-text-muted">用户回复: </span>
            <span className="text-sm text-hub-text">{p.answer}</span>
          </div>
        )}
      </div>
    )
  }

  const PENDING_STATUSES = new Set(['draft', 'pending_review'])
  const pendingDocs = docs.filter((d) => PENDING_STATUSES.has(d.status))
  const completedDocs = docs.filter((d) => !PENDING_STATUSES.has(d.status))
  const pendingCount = pendingDocs.length + pending.length
  const historyCount = completedDocs.length + history.length
  const hasContent = pendingCount > 0 || historyCount > 0
  const [showHistory, setShowHistory] = useState(true)

  const yoloContent = (
    <div className="p-5">
      {/* YOLO input — always visible at top when agents exist */}
      {agents.length > 0 && (
        <div className="mb-5 space-y-3">
          <textarea
            ref={textareaRef}
            value={yoloInput}
            onChange={(e) => setYoloInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
                e.preventDefault()
                handleStartYolo()
              }
            }}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
            placeholder="描述你的极限目标…（⌘+Enter 发送）"
            rows={2}
            className="w-full bg-hub-bg border border-hub-border rounded-lg px-4 py-3 text-sm text-hub-text placeholder:text-hub-text-muted resize-y min-h-[60px] focus:outline-none focus:border-hub-orange transition-[border-color]"
          />
          <button
            onClick={handleStartYolo}
            disabled={!yoloInput.trim() || sending}
            className="px-5 py-2 text-sm rounded-lg bg-hub-orange/80 text-white hover:bg-hub-orange disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
          >
            {sending ? '发送中...' : '发起 YOLO 对齐'}
          </button>
        </div>
      )}

      {agents.length === 0 && !hasContent && (
        <div className="text-center py-12 space-y-4">
          <p className="text-lg font-medium text-hub-orange">YOLO 全自动模式</p>
          <p className="text-sm text-hub-text-muted max-w-lg mx-auto leading-relaxed">
            对齐是 YOLO 的核心。Agent 先与你确认极限目标、工作逻辑和预期体验，
            确认后全自动执行。需要有在线 Agent 才能发起。
          </p>
        </div>
      )}

      {/* Pending section */}
      <section>
        <div className="flex items-center gap-3 mb-3 pb-2 border-b border-hub-border">
          <h2 className="text-base font-semibold flex items-center gap-2">
            Pending
            <span className="text-[0.7rem] px-2 py-0.5 rounded-lg bg-hub-accent-bg text-white">
              {pendingCount}
            </span>
          </h2>
        </div>

        <div className="space-y-4">
          {pendingDocs.map((doc) => renderAlignmentDoc(doc))}
          {pending.map((p) => renderPromptPlan(p, true))}
          {pendingCount === 0 && (
            <p className="text-sm text-hub-text-muted italic text-center py-8">
              没有待处理的 YOLO 方案。Agent 发起对齐后会出现在这里。
            </p>
          )}
        </div>
      </section>

    </div>
  )

  const yoloHistory = (
    <HistoryPanel
      count={historyCount}
      show={showHistory}
      onToggleShow={() => setShowHistory(!showHistory)}
      storageKey="pc-yolo-history-ratio"
      emptyText="尚无 YOLO 历史记录"
    >
      {completedDocs.map((doc) => (
        <YoloHistoryCard key={`doc-${doc.id}`} type="doc" doc={doc} />
      ))}
      {history.map((p) => (
        <YoloHistoryCard key={`prompt-${p.id}`} type="prompt" prompt={p} />
      ))}
    </HistoryPanel>
  )

  return (
    <div className="-mx-6 -mt-2 h-[calc(100vh-80px)]">
      <ResizableSplitPane
        left={yoloContent}
        right={yoloHistory}
        defaultRatio={0.68}
        minLeftPx={400}
        minRightPx={220}
        storageKey="pc-yolo-history-ratio"
        paneLabel="YOLO History"
        className="h-full"
      />
    </div>
  )
}
