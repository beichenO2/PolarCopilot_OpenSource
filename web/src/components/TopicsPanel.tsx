import { useState, useCallback } from 'react'
import { useTopicsStore, type Topic } from '../stores/topics'
import type { SSOTAnnotation } from '../lib/api'

interface Props {
  /** collect: SSoT页，接收批注拖入；reference: PromptsPage，主题可拖出到Pending */
  mode: 'collect' | 'reference'
}

export function TopicsPanel({ mode }: Props) {
  const { topics, addTopic, removeTopic, renameTopic, addAnnotationToTopic, removeAnnotationFromTopic } =
    useTopicsStore()

  const [newTopicName, setNewTopicName] = useState('')
  const [adding, setAdding] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')

  const handleCreate = useCallback(() => {
    const name = newTopicName.trim()
    if (!name) return
    addTopic(name)
    setNewTopicName('')
    setAdding(false)
  }, [newTopicName, addTopic])

  const handleTopicDrop = useCallback(
    (topicId: string, e: React.DragEvent) => {
      e.preventDefault()
      setDropTarget(null)
      const annData = e.dataTransfer.getData('application/x-ssot-annotation')
      if (!annData) return
      try {
        const ann: SSOTAnnotation = JSON.parse(annData)
        addAnnotationToTopic(topicId, ann)
      } catch {
        // malformed payload, ignore
      }
    },
    [addAnnotationToTopic],
  )

  const handleTopicDragStart = useCallback((topic: Topic, e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-ssot-topic', JSON.stringify(topic))
    e.dataTransfer.effectAllowed = 'copy'
  }, [])

  return (
    <div className="mt-4 pt-3 border-t border-zinc-800">
      {/* Header */}
      <div className="px-2 mb-2 flex items-center justify-between">
        <span className="text-[0.65rem] text-zinc-500 font-medium uppercase tracking-wider flex items-center gap-1.5">
          <span>主题</span>
          {topics.length > 0 && (
            <span className="bg-blue-500/20 text-blue-400 text-[0.55rem] px-1 py-px rounded-full font-bold">
              {topics.length}
            </span>
          )}
        </span>
        <button
          onClick={() => setAdding(v => !v)}
          className="text-[0.6rem] text-blue-400 hover:text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 hover:border-blue-400/50 transition-colors"
          title="新建主题"
        >
          + 新建
        </button>
      </div>

      {/* New topic input */}
      {adding && (
        <div className="px-2 mb-2 flex gap-1.5 items-center">
          <input
            autoFocus
            value={newTopicName}
            onChange={e => setNewTopicName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') { setAdding(false); setNewTopicName('') }
            }}
            placeholder="主题名称..."
            className="flex-1 text-[0.7rem] bg-zinc-900 border border-blue-500/40 rounded px-2 py-1 text-zinc-200 focus:outline-none focus:border-blue-500 placeholder-zinc-600"
          />
          <button
            onClick={handleCreate}
            className="text-[0.65rem] px-2 py-1 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition-colors shrink-0"
          >
            确定
          </button>
        </div>
      )}

      {/* Topic list */}
      <div className="space-y-1.5 px-1">
        {topics.length === 0 && !adding && (
          <p className="text-[0.6rem] text-zinc-700 px-2 py-3 text-center leading-relaxed">
            {mode === 'collect'
              ? '新建主题，然后将 SSoT 批注拖入'
              : '还没有主题，在 SSoT 页创建并收集批注'}
          </p>
        )}

        {topics.map(topic => (
          <div
            key={topic.id}
            draggable={mode === 'reference' && topic.annotations.length > 0}
            onDragStart={mode === 'reference' && topic.annotations.length > 0
              ? (e) => handleTopicDragStart(topic, e)
              : undefined}
            onDragOver={mode === 'collect'
              ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropTarget(topic.id) }
              : undefined}
            onDragLeave={mode === 'collect' ? () => setDropTarget(null) : undefined}
            onDrop={mode === 'collect' ? (e) => handleTopicDrop(topic.id, e) : undefined}
            className={[
              'rounded-lg border px-2.5 py-2 text-[0.7rem] transition-all duration-150',
              dropTarget === topic.id
                ? 'border-blue-500/70 bg-blue-500/10 shadow-sm'
                : mode === 'reference' && topic.annotations.length > 0
                  ? 'border-zinc-700 bg-zinc-900 cursor-grab hover:border-blue-500/40 active:cursor-grabbing'
                  : 'border-zinc-800 bg-zinc-900/40',
            ].join(' ')}
          >
            {/* Topic header */}
            <div className="flex items-center gap-1.5 min-w-0">
              {mode === 'reference' && topic.annotations.length > 0 && (
                <span className="text-zinc-600 text-[0.7rem] shrink-0 select-none">⠿</span>
              )}
              {mode === 'collect' && (
                <span className="text-zinc-700 text-[0.65rem] shrink-0 select-none" title="拖入批注">↓</span>
              )}

              {editingId === topic.id ? (
                <input
                  autoFocus
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  onBlur={() => {
                    renameTopic(topic.id, editName.trim() || topic.name)
                    setEditingId(null)
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      renameTopic(topic.id, editName.trim() || topic.name)
                      setEditingId(null)
                    }
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="flex-1 min-w-0 text-[0.7rem] bg-transparent border-b border-blue-500/50 focus:outline-none text-zinc-200"
                />
              ) : (
                <span
                  className="flex-1 min-w-0 text-zinc-300 font-medium truncate cursor-text"
                  onDoubleClick={() => { setEditingId(topic.id); setEditName(topic.name) }}
                  title={`${topic.name}（双击重命名）`}
                >
                  {topic.name}
                </span>
              )}

              <span className="text-zinc-600 text-[0.58rem] shrink-0 tabular-nums">
                {topic.annotations.length}条
              </span>
              <button
                onClick={() => removeTopic(topic.id)}
                className="text-zinc-700 hover:text-red-400 transition-colors text-[0.8rem] leading-none shrink-0 px-0.5"
                title="删除主题"
              >
                ×
              </button>
            </div>

            {/* Annotations list */}
            {topic.annotations.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {topic.annotations.map(ann => (
                  <div
                    key={ann.id}
                    className="flex items-start gap-1 text-[0.6rem] text-zinc-500 leading-snug group/ann"
                  >
                    <span className="text-blue-400/60 shrink-0 mt-px">·</span>
                    <span className="truncate flex-1 min-w-0" title={ann.text}>
                      {ann.text}
                    </span>
                    <button
                      onClick={() => removeAnnotationFromTopic(topic.id, ann.id)}
                      className="text-zinc-700 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover/ann:opacity-100"
                      title="移除"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Empty drop hint */}
            {mode === 'collect' && topic.annotations.length === 0 && (
              <p className="text-[0.58rem] text-zinc-700 text-center py-1.5 mt-1 border border-dashed border-zinc-800 rounded">
                将批注拖入此主题
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
