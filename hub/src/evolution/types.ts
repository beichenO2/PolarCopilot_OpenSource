export type SignalType =
  | 'error_pattern'
  | 'repeated_action'
  | 'perf_bottleneck'
  | 'user_feedback'
  | 'rule_gap'
  | 'api_misuse'
  | 'stale_reference'
  | 'skill_ambiguity'
  | 'fix_pattern'
  | 'tool_improvement';

export type SuggestionStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'done' | 'failed';

export interface EvolutionSignal {
  id: string;
  type: SignalType;
  source: string;
  agentId?: string;
  title: string;
  details: string;
  context?: Record<string, unknown>;
  createdAt: Date;
}

export interface EvolutionGene {
  id: string;
  category: 'repair' | 'optimize' | 'innovate';
  title: string;
  signalsMatch: string[];
  strategy: string[];
  validation: string[];
  constraints: {
    maxFiles?: number;
    forbiddenPaths?: string[];
  };
  successCount: number;
  failureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EvolutionSuggestion {
  id: string;
  geneId: string;
  signalIds: string[];
  status: SuggestionStatus;
  title: string;
  analysis: string;
  proposedChange: string;
  blastRadius: { files: number; lines: number };
  agentId?: string;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
  rejectReason?: string;
}

export interface EvolutionEvent {
  id: string;
  suggestionId: string;
  geneId: string;
  intent: 'repair' | 'optimize' | 'innovate';
  signalsUsed: string[];
  blastRadius: { files: number; lines: number };
  gitCommit?: string;
  outcome: 'success' | 'failure' | 'rollback';
  summary: string;
  createdAt: Date;
}
