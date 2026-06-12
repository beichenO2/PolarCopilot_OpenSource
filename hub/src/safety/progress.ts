import { and, eq, sql } from 'drizzle-orm';
import { tasks, type HubDb } from '../persistence/db.js';
import type { ProgressAggregate, WorkflowStage } from '../types.js';

const STAGES: WorkflowStage[] = ['discuss', 'research', 'plan', 'execute', 'verify'];

export function buildProgressByPhase(db: HubDb, filter?: WorkflowStage): ProgressAggregate[] {
  const stages = filter ? [filter] : STAGES;
  return stages.map((phase) => {
    const totalRow = db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(tasks)
      .where(eq(tasks.workflowStage, phase))
      .get();
    const doneRow = db
      .select({ c: sql<number>`count(*)`.mapWith(Number) })
      .from(tasks)
      .where(and(eq(tasks.workflowStage, phase), eq(tasks.status, 'done')))
      .get();
    const claimed = db
      .select({ owner: tasks.ownerAgentId })
      .from(tasks)
      .where(and(eq(tasks.workflowStage, phase), eq(tasks.status, 'claimed')))
      .all();
    const active_agents = new Set(claimed.map((c) => c.owner).filter(Boolean)).size;
    return {
      phase,
      completed: doneRow?.c ?? 0,
      total: totalRow?.c ?? 0,
      active_agents,
    };
  });
}
