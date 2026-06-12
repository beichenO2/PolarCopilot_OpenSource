import { eq, desc, sql } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { evolutionGenes } from './schema.js';
import type { EvolutionGene } from './types.js';
import { SEED_GENES } from './seed-genes.js';

function rowToGene(r: typeof evolutionGenes.$inferSelect): EvolutionGene {
  return {
    id: r.id,
    category: r.category as EvolutionGene['category'],
    title: r.title,
    signalsMatch: JSON.parse(r.signalsMatchJson),
    strategy: JSON.parse(r.strategyJson),
    validation: JSON.parse(r.validationJson),
    constraints: JSON.parse(r.constraintsJson),
    successCount: r.successCount,
    failureCount: r.failureCount,
    createdAt: r.createdAt!,
    updatedAt: r.updatedAt!,
  };
}

export function createGeneService(db: HubDb) {
  return {
    seedIfEmpty(): number {
      const row = db.select({ c: sql<number>`count(*)`.mapWith(Number) }).from(evolutionGenes).get();
      if ((row?.c ?? 0) > 0) return 0;

      const now = new Date();
      let seeded = 0;
      for (const g of SEED_GENES) {
        db.insert(evolutionGenes).values({
          id: g.id,
          category: g.category,
          title: g.title,
          signalsMatchJson: JSON.stringify(g.signalsMatch),
          strategyJson: JSON.stringify(g.strategy),
          validationJson: JSON.stringify(g.validation),
          constraintsJson: JSON.stringify(g.constraints),
          createdAt: now,
          updatedAt: now,
        }).run();
        seeded++;
      }
      return seeded;
    },

    listAll(): EvolutionGene[] {
      return db.select().from(evolutionGenes)
        .orderBy(desc(evolutionGenes.updatedAt))
        .all()
        .map(rowToGene);
    },

    getById(id: string): EvolutionGene | null {
      const r = db.select().from(evolutionGenes).where(eq(evolutionGenes.id, id)).get();
      return r ? rowToGene(r) : null;
    },

    incrementSuccess(id: string): void {
      const gene = db.select().from(evolutionGenes).where(eq(evolutionGenes.id, id)).get();
      if (!gene) return;
      db.update(evolutionGenes)
        .set({ successCount: gene.successCount + 1, updatedAt: new Date() })
        .where(eq(evolutionGenes.id, id))
        .run();
    },

    incrementFailure(id: string): void {
      const gene = db.select().from(evolutionGenes).where(eq(evolutionGenes.id, id)).get();
      if (!gene) return;
      db.update(evolutionGenes)
        .set({ failureCount: gene.failureCount + 1, updatedAt: new Date() })
        .where(eq(evolutionGenes.id, id))
        .run();
    },

    matchSignals(signalTypes: string[]): EvolutionGene[] {
      const all = this.listAll();
      const scored: { gene: EvolutionGene; score: number }[] = [];

      for (const gene of all) {
        let matchCount = 0;
        for (const match of gene.signalsMatch) {
          if (signalTypes.includes(match)) matchCount++;
        }
        if (matchCount > 0) {
          const total = gene.successCount + gene.failureCount;
          const successRate = total > 0 ? gene.successCount / total : 0.5;
          scored.push({ gene, score: matchCount * (0.5 + successRate) });
        }
      }

      return scored
        .sort((a, b) => b.score - a.score)
        .map(s => s.gene);
    },
  };
}
