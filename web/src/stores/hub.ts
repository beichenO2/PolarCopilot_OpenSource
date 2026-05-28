import { create } from 'zustand'
import type { Prompt } from '../types/hub'
import { api } from '../lib/api'

interface HubState {
  pendingPrompts: Prompt[]
  historyPrompts: Prompt[]

  fetchPrompts: () => Promise<void>
  fetchHistory: () => Promise<void>
  answerPrompt: (id: string, answer: string) => Promise<void>
}

function stableKey(arr: unknown[]): string {
  return arr.map((x: any) => {
    const id = x.id ?? x.agent_id ?? ''
    return `${id}:${x.answered ?? ''}:${x.last_ping ?? ''}:${x.answer ?? ''}:${x.display_name ?? ''}:${x.type ?? ''}:${x.prompt?.slice(0, 80) ?? ''}:${x.created_at ?? ''}`
  }).join('|')
}

export const useHubStore = create<HubState>((set, get) => ({
  pendingPrompts: [],
  historyPrompts: [],

  fetchPrompts: async () => {
    const prompts = await api.prompts.pending()
    if (stableKey(prompts) !== stableKey(get().pendingPrompts)) set({ pendingPrompts: prompts })
  },

  fetchHistory: async () => {
    const history = await api.prompts.history(100)
    if (stableKey(history) !== stableKey(get().historyPrompts)) set({ historyPrompts: history })
  },

  answerPrompt: async (id, answer) => {
    await api.prompts.answer(id, answer)
    await get().fetchPrompts()
    await get().fetchHistory()
  },
}))
