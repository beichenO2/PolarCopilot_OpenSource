import { randomUUID } from 'node:crypto';
import { eq, isNull, desc } from 'drizzle-orm';
import type { HubDb } from '../persistence/db.js';
import { evolutionSignals } from './schema.js';
import type { SignalType, EvolutionSignal } from './types.js';

const VALID_TYPES: SignalType[] = [
  'error_pattern',
  'repeated_action',
  'perf_bottleneck',
  'user_feedback',
  'rule_gap',
  'api_misuse',
  'stale_reference',
  'skill_ambiguity',
  'fix_pattern',
  'tool_improvement',
];

export function createSignalService(db: HubDb) {
  return {
    submit(input: {
      type: string;
      source: string;
      agentId?: string;
      title: string;
      details: string;
      context?: Record<string, unknown>;
    }): EvolutionSignal {
      if (!VALID_TYPES.includes(input.type as SignalType)) {
        throw new Error(`Invalid signal type: ${input.type}. Valid: ${VALID_TYPES.join(', ')}`);
      }
      const id = randomUUID();
      const now = new Date();
      db.insert(evolutionSignals).values({
        id,
        type: input.type,
        source: input.source,
        agentId: input.agentId ?? null,
        title: input.title,
        details: input.details,
        contextJson: JSON.stringify(input.context ?? {}),
        createdAt: now,
      }).run();

      return {
        id,
        type: input.type as SignalType,
        source: input.source,
        agentId: input.agentId,
        title: input.title,
        details: input.details,
        context: input.context,
        createdAt: now,
      };
    },

    listUnprocessed(limit = 50): EvolutionSignal[] {
      const rows = db.select().from(evolutionSignals)
        .where(isNull(evolutionSignals.processedAt))
        .orderBy(desc(evolutionSignals.createdAt))
        .limit(limit)
        .all();

      return rows.map(r => ({
        id: r.id,
        type: r.type as SignalType,
        source: r.source,
        agentId: r.agentId ?? undefined,
        title: r.title,
        details: r.details,
        context: JSON.parse(r.contextJson),
        createdAt: r.createdAt!,
      }));
    },

    listAll(limit = 100): EvolutionSignal[] {
      const rows = db.select().from(evolutionSignals)
        .orderBy(desc(evolutionSignals.createdAt))
        .limit(limit)
        .all();

      return rows.map(r => ({
        id: r.id,
        type: r.type as SignalType,
        source: r.source,
        agentId: r.agentId ?? undefined,
        title: r.title,
        details: r.details,
        context: JSON.parse(r.contextJson),
        createdAt: r.createdAt!,
      }));
    },

    markProcessed(ids: string[]): void {
      const now = new Date();
      for (const id of ids) {
        db.update(evolutionSignals)
          .set({ processedAt: now })
          .where(eq(evolutionSignals.id, id))
          .run();
      }
    },

    getById(id: string): EvolutionSignal | null {
      const r = db.select().from(evolutionSignals)
        .where(eq(evolutionSignals.id, id))
        .get();
      if (!r) return null;
      return {
        id: r.id,
        type: r.type as SignalType,
        source: r.source,
        agentId: r.agentId ?? undefined,
        title: r.title,
        details: r.details,
        context: JSON.parse(r.contextJson),
        createdAt: r.createdAt!,
      };
    },
  };
}
