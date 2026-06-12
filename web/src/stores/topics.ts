import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SSOTAnnotation } from '../lib/api'

export interface Topic {
  id: string
  name: string
  annotations: SSOTAnnotation[]
  createdAt: number
}

interface TopicsState {
  topics: Topic[]
  addTopic: (name: string) => string
  removeTopic: (id: string) => void
  renameTopic: (id: string, name: string) => void
  addAnnotationToTopic: (topicId: string, ann: SSOTAnnotation) => void
  removeAnnotationFromTopic: (topicId: string, annId: string) => void
}

export const useTopicsStore = create<TopicsState>()(
  persist(
    (set) => ({
      topics: [],

      addTopic: (name) => {
        const id = `topic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
        set(state => ({
          topics: [...state.topics, { id, name, annotations: [], createdAt: Date.now() }],
        }))
        return id
      },

      removeTopic: (id) =>
        set(state => ({ topics: state.topics.filter(t => t.id !== id) })),

      renameTopic: (id, name) =>
        set(state => ({
          topics: state.topics.map(t => (t.id === id ? { ...t, name } : t)),
        })),

      addAnnotationToTopic: (topicId, ann) =>
        set(state => ({
          topics: state.topics.map(t =>
            t.id === topicId && !t.annotations.some(a => a.id === ann.id)
              ? { ...t, annotations: [...t.annotations, ann] }
              : t,
          ),
        })),

      removeAnnotationFromTopic: (topicId, annId) =>
        set(state => ({
          topics: state.topics.map(t =>
            t.id === topicId
              ? { ...t, annotations: t.annotations.filter(a => a.id !== annId) }
              : t,
          ),
        })),
    }),
    { name: 'polarisor-topics' },
  ),
)
