import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { evolutionSuggestions } from './schema.js';
import type { SuggestionStatus, EvolutionSuggestion } from './types.js';

function rowToSuggestion(r: typeof evolutionSuggestions.$inferSelect): EvolutionSuggestion {
  return {
    id: r.id,
    geneId: r.geneId,
    signalIds: JSON.parse(r.signalIdsJson),
    status: r.status as SuggestionStatus,
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
  };
}

export function createSuggestionService(db: HubDb) {
  return {
    create(input: {
      geneId: string;
      signalIds: string[];
      title: string;
      analysis: string;
      proposedChange: string;
      blastRadius?: { files: number; lines: number };
    }): EvolutionSuggestion {
      const id = randomUUID();
      const now = new Date();
      db.insert(evolutionSuggestions).values({
        id,
        geneId: input.geneId,
        signalIdsJson: JSON.stringify(input.signalIds),
        status: 'pending',
        title: input.title,
        analysis: input.analysis,
        proposedChange: input.proposedChange,
        blastRadiusJson: JSON.stringify(input.blastRadius ?? { files: 0, lines: 0 }),
        createdAt: now,
        updatedAt: now,
      }).run();

      return {
        id,
        geneId: input.geneId,
        signalIds: input.signalIds,
        status: 'pending',
        title: input.title,
        analysis: input.analysis,
        proposedChange: input.proposedChange,
        blastRadius: input.blastRadius ?? { files: 0, lines: 0 },
        createdAt: now,
        updatedAt: now,
      };
    },

    listByStatus(status?: SuggestionStatus, limit = 50): EvolutionSuggestion[] {
      let query = db.select().from(evolutionSuggestions);
      if (status) {
        return query.where(eq(evolutionSuggestions.status, status))
          .orderBy(desc(evolutionSuggestions.createdAt))
          .limit(limit)
          .all()
          .map(rowToSuggestion);
      }
      return query.orderBy(desc(evolutionSuggestions.createdAt))
        .limit(limit)
        .all()
        .map(rowToSuggestion);
    },

    getById(id: string): EvolutionSuggestion | null {
      const r = db.select().from(evolutionSuggestions)
        .where(eq(evolutionSuggestions.id, id)).get();
      return r ? rowToSuggestion(r) : null;
    },

    approve(id: string, by?: string): EvolutionSuggestion | null {
      const now = new Date();
      db.update(evolutionSuggestions)
        .set({ status: 'approved', resolvedAt: now, resolvedBy: by ?? 'user', updatedAt: now })
        .where(eq(evolutionSuggestions.id, id))
        .run();
      return this.getById(id);
    },

    reject(id: string, reason: string, by?: string): EvolutionSuggestion | null {
      const now = new Date();
      db.update(evolutionSuggestions)
        .set({ status: 'rejected', rejectReason: reason, resolvedAt: now, resolvedBy: by ?? 'user', updatedAt: now })
        .where(eq(evolutionSuggestions.id, id))
        .run();
      return this.getById(id);
    },

    updateStatus(id: string, status: SuggestionStatus): void {
      db.update(evolutionSuggestions)
        .set({ status, updatedAt: new Date() })
        .where(eq(evolutionSuggestions.id, id))
        .run();
    },
  };
}
