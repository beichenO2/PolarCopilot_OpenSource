import { useState, useRef, useCallback, useEffect } from 'react'
import { clsx } from 'clsx'
import { renderMarkdown } from '../lib/markdown'
import type { Prompt } from '../types/hub'
import { optionLabel } from '../types/hub'

interface Annotation {
  id: string
  text: string
  note: string
}

interface Props {
  prompt: Prompt
  onAnswer?: (id: string, answer: string) => void
  onDismiss?: (id: string) => void
  isHistory?: boolean
  linkedPromptId?: string | null
  savedDraft?: string
  savedHeight?: number
  onDraftChange?: (text: string) => void
  onHeightChange?: (height: number) => void
  onDragStartPrompt?: (prompt: Prompt) => void
}

export function PromptCard({ prompt, onAnswer, onDismiss, isHistory, linkedPromptId, savedDraft, savedHeight, onDraftChange, onHeightChange, onDragStartPrompt }: Props) {
  const [customInput, setCustomInput] = useState(savedDraft ?? '')
  const [isComposing, setIsComposing] = useState(false)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [selectedOptions, setSelectedOptions] = useState<Set<string>>(new Set())
  const [annotating, setAnnotating] = useState<{ text: string; range: Range } | null>(null)
  const [annotationNote, setAnnotationNote] = useState('')
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const annTextareaRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  const agentLabel = prompt.display_name || prompt.agent_id || 'System'
  const isPending = !prompt.answered && !isHistory
  const isLinked = linkedPromptId === prompt.id

  const handleAnswer = useCallback(
    (answer: string) => {
      onAnswer?.(prompt.id, answer)
    },
    [onAnswer, prompt.id],
  )

  const buildAndSend = useCallback(() => {
    const parts: string[] = []

    if (selectedOptions.size > 0) {
      parts.push([...selectedOptions].join('、'))
    }

    if (customInput.trim()) {
      parts.push(customInput.trim())
    }

    if (annotations.length > 0) {
      const annParts = annotations.map((a, i) =>
        `【批注 ${i + 1}】"${a.text}"\n→ ${a.note}`
      )
      parts.push(annParts.join('\n\n'))
    }

    if (parts.length === 0) return

    handleAnswer(parts.join('\n\n'))
    annotations.forEach(a => removeAnnotationMarks(a.id))
    setAnnotations([])
    setSelectedOptions(new Set())
    setCustomInput('')
    onDraftChange?.('')
  }, [selectedOptions, customInput, annotations, handleAnswer, onDraftChange])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !isComposing) {
      e.preventDefault()
      buildAndSend()
    }
  }

  const hasSendContent = customInput.trim().length > 0 || selectedOptions.size > 0 || annotations.length > 0

  const autoResize = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const prev = el.style.overflow
    el.style.overflow = 'hidden'
    el.style.height = 'auto'
    const desired = Math.max(el.scrollHeight, 80)
    el.style.height = `${Math.min(desired, 500)}px`
    el.style.overflow = desired > 500 ? 'auto' : prev
    onHeightChange?.(desired)
  }, [onHeightChange])

  useEffect(() => { autoResize() }, [customInput, autoResize])

  useEffect(() => {
    const el = annTextareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, 32)}px`
  }, [annotationNote])

  useEffect(() => {
    if (savedHeight && textareaRef.current) {
      textareaRef.current.style.height = `${Math.min(savedHeight, 500)}px`
    }
  }, [])

  const handleTextSelect = useCallback(() => {
    if (!contentRef.current || !cardRef.current) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.rangeCount) return
    const range = sel.getRangeAt(0)
    if (!contentRef.current.contains(range.commonAncestorContainer)) return
    const text = sel.toString().trim()
    if (text.length > 0) {
      const rangeRect = range.getBoundingClientRect()
      const cardRect = cardRef.current.getBoundingClientRect()
      setAnnotating({ text, range: range.cloneRange() })
      setPopoverPos({
        top: rangeRect.bottom - cardRect.top + 4,
        left: Math.max(0, Math.min(rangeRect.left - cardRect.left, cardRect.width - 420)),
      })
      setAnnotationNote('')
    }
  }, [])

  const injectAnnotationMark = useCallback((range: Range, annId: string, note: string, index: number) => {
    if (!contentRef.current) return
    try {
      const mark = document.createElement('mark')
      mark.className = 'pc-annotation-highlight'
      mark.dataset.annId = annId
      mark.style.cssText = 'background: rgba(56,139,253,0.15); border-bottom: 2px solid rgba(56,139,253,0.5); padding: 0 1px; border-radius: 2px;'
      range.surroundContents(mark)

      const noteEl = document.createElement('span')
      noteEl.className = 'pc-annotation-note'
      noteEl.dataset.annId = annId
      noteEl.style.cssText = 'display: inline-flex; align-items: baseline; gap: 4px; margin-left: 4px; padding: 1px 6px; font-size: 0.75rem; background: rgba(31,61,90,0.25); border: 1px solid rgba(56,139,253,0.3); border-radius: 4px; color: #8b949e; vertical-align: baseline; line-height: 1.4;'
      noteEl.innerHTML = `<span style="color:#58a6ff;font-weight:600;">#${index}</span> ${note.replace(/</g, '&lt;')}`
      mark.after(noteEl)
    } catch {
      const container = contentRef.current
      const noteBlock = document.createElement('div')
      noteBlock.className = 'pc-annotation-note'
      noteBlock.dataset.annId = annId
      noteBlock.style.cssText = 'margin: 6px 0; padding: 6px 10px; font-size: 0.8rem; background: rgba(31,61,90,0.15); border-left: 3px solid rgba(56,139,253,0.5); border-radius: 0 6px 6px 0; color: #8b949e; line-height: 1.5;'
      noteBlock.innerHTML = `<span style="color:#58a6ff;font-weight:600;">#${index}</span> <span style="color:#8b949e;font-style:italic;">"${range.toString().slice(0, 60).replace(/</g, '&lt;')}${range.toString().length > 60 ? '...' : ''}"</span><br/><span style="color:#e6edf3;">${note.replace(/</g, '&lt;')}</span>`

      const ancestor = range.commonAncestorContainer
      const blockParent = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor as HTMLElement
      const tableParent = blockParent?.closest('table')
      if (tableParent) {
        tableParent.after(noteBlock)
      } else if (blockParent && container.contains(blockParent)) {
        blockParent.after(noteBlock)
      } else {
        container.appendChild(noteBlock)
      }
    }
  }, [])

  const removeAnnotationMarks = useCallback((annId: string) => {
    if (!contentRef.current) return
    const marks = contentRef.current.querySelectorAll(`mark[data-ann-id="${annId}"]`)
    marks.forEach(mark => {
      const parent = mark.parentNode
      while (mark.firstChild) parent?.insertBefore(mark.firstChild, mark)
      parent?.removeChild(mark)
    })
    const notes = contentRef.current.querySelectorAll(`.pc-annotation-note[data-ann-id="${annId}"]`)
    notes.forEach(n => n.remove())
  }, [])

  const addAnnotation = useCallback(() => {
    if (!annotating || !annotationNote.trim()) return
    const annId = `ann-${Date.now()}`
    const newAnn: Annotation = {
      id: annId,
      text: annotating.text,
      note: annotationNote.trim(),
    }
    const newIndex = annotations.length + 1
    injectAnnotationMark(annotating.range, annId, annotationNote.trim(), newIndex)
    setAnnotations(prev => [...prev, newAnn])
    setAnnotating(null)
    setAnnotationNote('')
    window.getSelection()?.removeAllRanges()
  }, [annotating, annotationNote, annotations.length, injectAnnotationMark])

  const toggleOption = useCallback((opt: string) => {
    setSelectedOptions(prev => {
      const next = new Set(prev)
      if (next.has(opt)) next.delete(opt)
      else next.add(opt)
      return next
    })
  }, [])

  const [historyExpanded, setHistoryExpanded] = useState(false)

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-pending-prompt', JSON.stringify({
      id: prompt.id,
      agent_id: prompt.agent_id,
      display_name: prompt.display_name,
      prompt: prompt.prompt.slice(0, 200),
    }))
    e.dataTransfer.effectAllowed = 'link'
    onDragStartPrompt?.(prompt)
  }, [prompt, onDragStartPrompt])

  return (
    <div
      ref={cardRef}
      onDragOver={isPending ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; cardRef.current?.classList.add('ring-2', 'ring-blue-500/40') } : undefined}
      onDragLeave={isPending ? () => { cardRef.current?.classList.remove('ring-2', 'ring-blue-500/40') } : undefined}
      onDrop={isPending ? (e) => {
        e.preventDefault()
        cardRef.current?.classList.remove('ring-2', 'ring-blue-500/40')
        const ref = e.dataTransfer.getData('text/plain')?.trim()
        if (ref) {
          setCustomInput((prev) => (prev ? `${prev}\n\n${ref}` : ref))
        }
      } : undefined}
      className={clsx(
        'bg-hub-surface border rounded-xl p-5 mb-4 transition-[border-color,box-shadow] duration-200 relative',
        isLinked ? 'border-hub-accent/40 ring-1 ring-hub-accent/20' : 'border-hub-border',
        isHistory && 'opacity-50',
        isLinked && 'opacity-60',
        !isHistory && !isLinked && 'hover:border-[#484f58]',
      )}
    >
      {isPending && onDismiss && (
        <button
          onClick={() => onDismiss(prompt.id)}
          className="absolute top-3 right-3 w-6 h-6 flex items-center justify-center text-zinc-600 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors text-sm"
          title="关闭"
        >
          ✕
        </button>
      )}
      <div
        draggable={isPending && !annotating}
        onDragStart={isPending ? handleDragStart : undefined}
        className={clsx(
          'mb-2.5',
          isPending && !annotating && 'cursor-grab active:cursor-grabbing',
        )}
      >
        <div className="text-[0.7rem] text-[#484f58] mb-1.5">
          {new Date(prompt.created_at).toLocaleTimeString()}
        </div>
        <div className="flex items-center gap-2">
          {prompt.agent_id && (
            <span className="inline-block bg-[#21262d] border border-hub-border px-2.5 py-0.5 rounded-xl text-xs text-hub-text-muted" title={prompt.agent_id}>
              {agentLabel}
            </span>
          )}
          {prompt.answer === '[auto-closed: superseded by newer prompt]' && (
            <span className="inline-block bg-[#30363d] text-[#8b949e] text-[0.65rem] px-2 py-px rounded font-medium">
              已替代
            </span>
          )}
          {isPending && !isLinked && (
            <span className="text-[0.65rem] text-[#484f58] ml-auto select-none">
              拖拽此区域移动 · 选中文字可批注
            </span>
          )}
          {isLinked && (
            <span className="text-[0.65rem] text-hub-accent ml-auto select-none">
              ↑ 已关联
            </span>
          )}
        </div>
      </div>

      <div
        ref={contentRef}
        onMouseUp={isPending && !isLinked ? handleTextSelect : undefined}
        className="text-[1.05rem] mb-4 leading-[1.7] text-[#e6edf3] markdown-body"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(prompt.prompt) }}
      />

      {/* Annotation input popover */}
      {isPending && annotating && (
        <div
          className="pc-annotation-popover absolute z-20 left-5 right-5 bg-[#161b22] border border-hub-accent rounded-lg p-4 space-y-3 shadow-lg"
          style={{ top: popoverPos.top }}
        >
          <div className="text-sm text-hub-accent bg-[#1f3d5a]/30 rounded px-3 py-1.5 line-clamp-2">
            "{annotating.text}"
          </div>
          <textarea
            ref={annTextareaRef}
            value={annotationNote}
            onChange={(e) => setAnnotationNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                addAnnotation()
              }
              if (e.key === 'Escape') {
                setAnnotating(null)
                setAnnotationNote('')
              }
            }}
            placeholder="写下你的批注... (⌘+Enter 添加, Esc 取消)"
            rows={1}
            autoFocus
            className="w-full bg-hub-bg border border-hub-border rounded-lg px-3 py-2.5 text-[0.9rem] text-hub-text placeholder:text-hub-text-muted font-inherit leading-[1.5] focus:outline-none focus:border-hub-accent transition-[border-color] resize-none overflow-hidden"
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => { setAnnotating(null); setAnnotationNote('') }}
              className="px-4 py-2 text-sm rounded-lg border border-hub-border text-hub-text-muted hover:text-hub-text transition-colors"
            >
              取消
            </button>
            <button
              onClick={addAnnotation}
              disabled={!annotationNote.trim()}
              className="px-4 py-2 text-sm rounded-lg border border-hub-accent bg-hub-accent-bg text-white hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              添加批注
            </button>
          </div>
        </div>
      )}

      {/* Pending annotations indicator */}
      {annotations.length > 0 && isPending && (
        <div className="flex items-center gap-2 mb-2 text-[0.75rem] text-hub-accent">
          <span className="bg-hub-accent-bg/30 px-2 py-0.5 rounded">{annotations.length} 条批注待发送</span>
        </div>
      )}

      {/* Options as multi-select checkboxes (YOLO confirm filtered — only via /pc/yolo page) */}
      {isPending && prompt.options.length > 0 && (
        <div className="px-1 pb-3 flex flex-col gap-1.5">
          {prompt.options.filter((opt) => {
            const label = optionLabel(opt)
            return !label.includes('开始 YOLO') && !label.includes('开始YOLO')
          }).map((opt) => {
            const label = optionLabel(opt)
            return (
              <label
                key={label}
                className={clsx(
                  'flex items-center gap-3 px-4 py-2.5 text-[0.9rem] rounded-lg border cursor-pointer transition-colors',
                  selectedOptions.has(label)
                    ? 'border-hub-accent bg-hub-accent-bg/20 text-hub-text'
                    : 'border-hub-border bg-[#21262d] text-hub-text hover:bg-hub-border hover:border-hub-accent',
                )}
              >
                <input
                  type="checkbox"
                  checked={selectedOptions.has(label)}
                  onChange={() => toggleOption(label)}
                  className="w-4 h-4 rounded border-hub-border accent-hub-accent"
                />
                {label}
              </label>
            )
          })}
        </div>
      )}

      {/* Unified input + send */}
      {isPending && (
        <div className="flex gap-2 items-end mt-1">
          <textarea
            ref={textareaRef}
            value={customInput}
            onChange={(e) => { setCustomInput(e.target.value); onDraftChange?.(e.target.value) }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            placeholder="输入回复... (⌘+Enter 发送, Shift+Enter 换行)"
            rows={2}
            className="flex-1 bg-hub-bg border border-hub-border rounded-lg px-3 py-2.5 text-[0.9rem] text-hub-text placeholder:text-hub-text-muted max-h-[500px] font-inherit leading-[1.5] focus:outline-none focus:border-hub-accent transition-[border-color] resize-none"
          />
          <button
            onClick={buildAndSend}
            disabled={!hasSendContent}
            className="px-5 py-2.5 text-[0.9rem] rounded-lg border border-hub-accent bg-hub-accent-bg text-white whitespace-nowrap hover:opacity-85 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            发送
          </button>
        </div>
      )}

      {/* History: collapsible full answer */}
      {isHistory && prompt.answered && (
        <div className="mt-2">
          <button
            onClick={() => setHistoryExpanded(!historyExpanded)}
            className="inline-flex items-center gap-1.5 bg-[#238636] text-white px-2.5 py-0.5 rounded-md text-xs hover:bg-[#2ea043] transition-colors"
          >
            <span className={clsx('text-[0.6rem] transition-transform', historyExpanded && 'rotate-90')}>▶</span>
            已回复
          </button>
          {historyExpanded && (
            <div className="mt-2 p-3 bg-[#161b22] border border-hub-border rounded-lg text-[0.85rem] text-hub-text whitespace-pre-wrap leading-[1.6]">
              {prompt.answer}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
