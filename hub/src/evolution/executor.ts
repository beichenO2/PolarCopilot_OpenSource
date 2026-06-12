import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { evolutionEvents, evolutionSuggestions, evolutionGenes } from './schema.js';
import type { EvolutionEvent, EvolutionSuggestion } from './types.js';

export function createExecutionService(db: HubDb) {
  return {
    recordEvent(input: {
      suggestionId: string;
      geneId: string;
      intent: EvolutionEvent['intent'];
      signalsUsed: string[];
      blastRadius: { files: number; lines: number };
      gitCommit?: string;
      outcome: EvolutionEvent['outcome'];
      summary: string;
    }): EvolutionEvent {
      const id = randomUUID();
      const now = new Date();

      db.insert(evolutionEvents).values({
        id,
        suggestionId: input.suggestionId,
        geneId: input.geneId,
        intent: input.intent,
        signalsUsedJson: JSON.stringify(input.signalsUsed),
        blastRadiusJson: JSON.stringify(input.blastRadius),
        gitCommit: input.gitCommit ?? null,
        outcome: input.outcome,
        summary: input.summary,
        createdAt: now,
      }).run();

      if (input.outcome === 'success') {
        const gene = db.select().from(evolutionGenes)
          .where(eq(evolutionGenes.id, input.geneId)).get();
        if (gene) {
          db.update(evolutionGenes)
            .set({ successCount: gene.successCount + 1, updatedAt: now })
            .where(eq(evolutionGenes.id, input.geneId)).run();
        }
        db.update(evolutionSuggestions)
          .set({ status: 'done', updatedAt: now })
          .where(eq(evolutionSuggestions.id, input.suggestionId)).run();
      } else if (input.outcome === 'failure' || input.outcome === 'rollback') {
        const gene = db.select().from(evolutionGenes)
          .where(eq(evolutionGenes.id, input.geneId)).get();
        if (gene) {
          db.update(evolutionGenes)
            .set({ failureCount: gene.failureCount + 1, updatedAt: now })
            .where(eq(evolutionGenes.id, input.geneId)).run();
        }
        db.update(evolutionSuggestions)
          .set({ status: 'failed', updatedAt: now })
          .where(eq(evolutionSuggestions.id, input.suggestionId)).run();
      }

      return {
        id,
        suggestionId: input.suggestionId,
        geneId: input.geneId,
        intent: input.intent,
        signalsUsed: input.signalsUsed,
        blastRadius: input.blastRadius,
        gitCommit: input.gitCommit,
        outcome: input.outcome,
        summary: input.summary,
        createdAt: now,
      };
    },

    listEvents(limit = 50): EvolutionEvent[] {
      const rows = db.select().from(evolutionEvents)
        .orderBy(desc(evolutionEvents.createdAt))
        .limit(limit)
        .all();

      return rows.map(r => ({
        id: r.id,
        suggestionId: r.suggestionId,
        geneId: r.geneId,
        intent: r.intent as EvolutionEvent['intent'],
        signalsUsed: JSON.parse(r.signalsUsedJson),
        blastRadius: JSON.parse(r.blastRadiusJson),
        gitCommit: r.gitCommit ?? undefined,
        outcome: r.outcome as EvolutionEvent['outcome'],
        summary: r.summary,
        createdAt: r.createdAt!,
      }));
    },

    getApprovedSuggestions(): EvolutionSuggestion[] {
      const rows = db.select().from(evolutionSuggestions)
        .where(eq(evolutionSuggestions.status, 'approved'))
        .all();

      return rows.map(r => ({
        id: r.id,
        geneId: r.geneId,
        signalIds: JSON.parse(r.signalIdsJson),
        status: r.status as EvolutionSuggestion['status'],
        title: r.title,
        analysis: r.analysis,
        proposedChange: r.proposedChange,
        blastRadius: JSON.parse(r.blastRadiusJson),
        agentId: r.agentId ?? undefined,
        createdAt: r.createdAt!,
        updatedAt: r.updatedAt!,
        resolvedAt: r.resolvedAt ?? undefined,
        resolvedBy: r.resolvedBy ?? undefined,
        rejectReason: r.rejectReason ?? undefined,
      }));
    },

    markExecuting(suggestionId: string): void {
      db.update(evolutionSuggestions)
        .set({ status: 'executing', updatedAt: new Date() })
        .where(eq(evolutionSuggestions.id, suggestionId))
        .run();
    },
  };
}
