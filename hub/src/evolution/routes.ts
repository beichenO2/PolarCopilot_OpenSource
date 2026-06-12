import { Router } from 'express';
import type { HubDb } from '../persistence/db.js';
import { createSignalService } from './signals.js';
import { createGeneService } from './genes.js';
import { createSuggestionService } from './suggestions.js';
import { createExecutionService } from './executor.js';
import { detectSignals, buildHooksJson } from './hooks.js';

export function createEvolutionRouter(db: HubDb): Router {
  const router = Router();
  const signalSvc = createSignalService(db);
  const geneSvc = createGeneService(db);
  const execSvc = createExecutionService(db);
  const suggestionSvc = createSuggestionService(db);

  geneSvc.seedIfEmpty();

  // ── Signals ─────────────────────────────────────────────────────

  router.post('/signals', (req, res) => {
    try {
      const { type, source, agent_id, title, details, context } = req.body;
      if (!type || !source || !title || !details) {
        res.status(400).json({ error: 'missing required fields: type, source, title, details' });
        return;
      }
      const signal = signalSvc.submit({ type, source, agentId: agent_id, title, details, context });
      res.json({ ok: true, signal });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/signals', (req, res) => {
    try {
      const unprocessedOnly = req.query.unprocessed === 'true';
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
      const signals = unprocessedOnly ? signalSvc.listUnprocessed(limit) : signalSvc.listAll(limit);
      res.json(signals);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/signals/:id', (req, res) => {
    try {
      const signal = signalSvc.getById(req.params.id);
      if (!signal) { res.status(404).json({ error: 'not_found' }); return; }
      res.json(signal);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Genes ───────────────────────────────────────────────────────

  router.get('/genes', (_req, res) => {
    try {
      res.json(geneSvc.listAll());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/genes/:id', (req, res) => {
    try {
      const gene = geneSvc.getById(req.params.id);
      if (!gene) { res.status(404).json({ error: 'not_found' }); return; }
      res.json(gene);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/genes/match', (req, res) => {
    try {
      const { signal_types } = req.body;
      if (!Array.isArray(signal_types)) {
        res.status(400).json({ error: 'signal_types must be an array' });
        return;
      }
      res.json(geneSvc.matchSignals(signal_types));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Suggestions ─────────────────────────────────────────────────

  router.get('/suggestions', (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
      res.json(suggestionSvc.listByStatus(status as any, limit));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/suggestions/:id', (req, res) => {
    try {
      const s = suggestionSvc.getById(req.params.id);
      if (!s) { res.status(404).json({ error: 'not_found' }); return; }
      res.json(s);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/suggestions', (req, res) => {
    try {
      const { gene_id, signal_ids, title, analysis, proposed_change, blast_radius } = req.body;
      if (!gene_id || !title || !analysis || !proposed_change) {
        res.status(400).json({ error: 'missing required fields' });
        return;
      }
      const suggestion = suggestionSvc.create({
        geneId: gene_id,
        signalIds: signal_ids ?? [],
        title,
        analysis,
        proposedChange: proposed_change,
        blastRadius: blast_radius,
      });
      res.json({ ok: true, suggestion });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/suggestions/:id/approve', (req, res) => {
    try {
      const result = suggestionSvc.approve(req.params.id, req.body?.by);
      if (!result) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ ok: true, suggestion: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/suggestions/:id/reject', (req, res) => {
    try {
      const { reason } = req.body ?? {};
      const result = suggestionSvc.reject(req.params.id, reason ?? '', req.body?.by);
      if (!result) { res.status(404).json({ error: 'not_found' }); return; }
      res.json({ ok: true, suggestion: result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Execution ───────────────────────────────────────────────────

  router.get('/approved', (_req, res) => {
    try {
      res.json(execSvc.getApprovedSuggestions());
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/execute/:id/start', (req, res) => {
    try {
      execSvc.markExecuting(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/events', (req, res) => {
    try {
      const { suggestion_id, gene_id, intent, signals_used, blast_radius, git_commit, outcome, summary } = req.body;
      if (!suggestion_id || !gene_id || !outcome || !summary) {
        res.status(400).json({ error: 'missing required fields' });
        return;
      }
      const event = execSvc.recordEvent({
        suggestionId: suggestion_id,
        geneId: gene_id,
        intent: intent ?? 'repair',
        signalsUsed: signals_used ?? [],
        blastRadius: blast_radius ?? { files: 0, lines: 0 },
        gitCommit: git_commit,
        outcome,
        summary,
      });
      res.json({ ok: true, event });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/events', (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
      res.json(execSvc.listEvents(limit));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Auto-detect Signals ─────────────────────────────────────────

  router.post('/detect', (req, res) => {
    try {
      const { text, source } = req.body;
      if (!text || !source) {
        res.status(400).json({ error: 'missing text or source' });
        return;
      }
      const detected = detectSignals(text, source);
      const submitted = [];
      for (const d of detected) {
        try {
          const signal = signalSvc.submit(d);
          submitted.push(signal);
        } catch { /* skip duplicate-ish signals */ }
      }
      res.json({ ok: true, detected: detected.length, submitted: submitted.length, signals: submitted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Hooks Setup ─────────────────────────────────────────────────

  router.get('/hooks-config', (req, res) => {
    try {
      const port = parseInt(String(req.query.port ?? process.env.PC_HUB_PORT ?? '8040'), 10);
      res.json(buildHooksJson(port));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats ───────────────────────────────────────────────────────

  router.get('/stats', (_req, res) => {
    try {
      const signals = signalSvc.listAll(1000);
      const genes = geneSvc.listAll();
      const suggestions = suggestionSvc.listByStatus(undefined, 1000);

      res.json({
        signals: {
          total: signals.length,
          unprocessed: signals.filter(s => !('processedAt' in s)).length,
          byType: signals.reduce((acc, s) => {
            acc[s.type] = (acc[s.type] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
        genes: {
          total: genes.length,
          byCategory: genes.reduce((acc, g) => {
            acc[g.category] = (acc[g.category] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
        suggestions: {
          total: suggestions.length,
          pending: suggestions.filter(s => s.status === 'pending').length,
          approved: suggestions.filter(s => s.status === 'approved').length,
          rejected: suggestions.filter(s => s.status === 'rejected').length,
          done: suggestions.filter(s => s.status === 'done').length,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
