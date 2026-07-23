import type { XjAutomation } from './types.js';

export interface AutomationIterationResult {
  outcome: 'passed' | 'failed' | 'blocked';
  summary: string;
  failedPath?: string;
  completedCriteria?: string[];
  nextTodo?: string[];
}

export function createAutomation(input: Partial<XjAutomation> = {}): XjAutomation {
  return {
    enabled: input.enabled ?? false,
    state: input.state ?? 'idle',
    loop: input.loop ?? 0,
    loopLimit: Math.max(1, input.loopLimit ?? 20),
    acceptanceCriteria: [...(input.acceptanceCriteria ?? [])],
    completedCriteria: [...(input.completedCriteria ?? [])],
    todo: [...(input.todo ?? [])],
    negativeKnowledge: [...(input.negativeKnowledge ?? [])],
    ...(input.pauseReason ? { pauseReason: input.pauseReason } : {}),
    ...(input.lastReflection ? { lastReflection: input.lastReflection } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}

export function advanceAutomation(
  current: XjAutomation,
  result: AutomationIterationResult,
): XjAutomation {
  const completed = new Set([...current.completedCriteria, ...(result.completedCriteria ?? [])]);
  const negativeKnowledge = [...current.negativeKnowledge];
  if (result.failedPath && !negativeKnowledge.includes(result.failedPath)) {
    negativeKnowledge.push(result.failedPath);
  }

  const next: XjAutomation = {
    ...current,
    loop: current.loop + 1,
    completedCriteria: [...completed],
    todo: result.nextTodo ? [...result.nextTodo] : [...current.todo],
    negativeKnowledge,
    lastReflection: result.summary,
    updatedAt: new Date().toISOString(),
  };

  const allCriteriaMet = next.acceptanceCriteria.length > 0
    && next.acceptanceCriteria.every((criterion) => completed.has(criterion));
  if (allCriteriaMet && next.todo.length === 0) {
    return { ...next, state: 'done', enabled: false, pauseReason: undefined };
  }
  if (result.outcome === 'blocked') {
    return { ...next, state: 'paused', pauseReason: 'blocked' };
  }
  if (next.loop >= current.loopLimit) {
    return { ...next, state: 'paused', pauseReason: 'loop_limit' };
  }
  return { ...next, state: 'running', pauseReason: undefined };
}
