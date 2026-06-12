export type EcoLevel = 'ecosystem' | 'project' | 'requirement' | 'tech'

export interface EcoNode {
  id: string
  name: string
  level: EcoLevel
  tier?: 'infra' | 'knowledge' | 'app' | 'domain'
  description?: string
  source?: string
  children?: EcoNode[]
}

export interface EcoTree {
  version: string
  generated_at: string
  root: EcoNode
}
