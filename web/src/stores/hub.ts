import { create } from 'zustand'
import type { Agent, Prompt } from '../types/hub'
import { api } from '../lib/api'

interface HubState {
  agents: Agent[]
  pendingPrompts: Prompt[]
  historyPrompts: Prompt[]
  selectedAgentId: string | null

  fetchAgents: () => Promise<void>
  fetchPrompts: () => Promise<void>
  fetchHistory: () => Promise<void>
  selectAgent: (id: string | null) => void
  answerPrompt: (id: string, answer: string) => Promise<void>
}

function stableKey(arr: unknown[]): string {
  return arr.map((x: any) => {
    const id = x.id ?? x.agent_id ?? ''
    return `${id}:${x.answered ?? ''}:${x.alive ?? ''}:${x.last_ping ?? ''}:${x.answer ?? ''}:${x.display_name ?? ''}:${x.type ?? ''}:${x.prompt?.slice(0, 80) ?? ''}:${x.created_at ?? ''}:${x.role_status ?? ''}`
  }).join('|')
}

export const useHubStore = create<HubState>((set, get) => ({
  agents: [],
  pendingPrompts: [],
  historyPrompts: [],
  selectedAgentId: null,

  fetchAgents: async () => {
    const agents = await api.agents.list()
    if (stableKey(agents) !== stableKey(get().agents)) set({ agents })
  },

  fetchPrompts: async () => {
    const prompts = await api.prompts.pending()
    if (stableKey(prompts) !== stableKey(get().pendingPrompts)) set({ pendingPrompts: prompts })
  },

  fetchHistory: async () => {
    const history = await api.prompts.history(100)
    if (stableKey(history) !== stableKey(get().historyPrompts)) set({ historyPrompts: history })
  },

  selectAgent: (id) => set({ selectedAgentId: id }),

  answerPrompt: async (id, answer) => {
    await api.prompts.answer(id, answer)
    await get().fetchPrompts()
    await get().fetchHistory()
  },
}))
