import type { AfkDb } from './db.js';
import { getTask, transitionTask, type Result } from './store.js';
import type { AfkTaskRow } from './types.js';

const OPEN_UNIT_STATES = new Set(['pending', 'leased', 'in_progress', 'verifying', 'blocked']);

export interface CompletionGap {
  code:
    | 'task_not_found'
    | 'wrong_phase'
    | 'required_criteria_unmet'
    | 'stale_or_missing_evidence'
    | 'open_work_units'
    | 'handoff_language_forbidden'
    | 'evidence_count_mismatch';
  message: string;
  detail?: unknown;
}

export interface CompletionReport {
  ok: boolean;
  gaps: CompletionGap[];
  required_total: number;
  required_pass: number;
}

const EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // fresh within 24h for gate

/**
 * Deterministic completion evaluation. Models must not bypass this to write DONE.
 */
export function evaluateCompletion(db: AfkDb, taskId: string): CompletionReport {
  const gaps: CompletionGap[] = [];
  const task = getTask(db, taskId);
  if (!task) {
    return { ok: false, gaps: [{ code: 'task_not_found', message: `task ${taskId} not found` }], required_total: 0, required_pass: 0 };
  }

  if (task.status !== 'READY_TO_DELIVER' && task.status !== 'VERIFYING') {
    gaps.push({
      code: 'wrong_phase',
      message: `status ${task.status} cannot complete; need READY_TO_DELIVER or VERIFYING`,
      detail: { status: task.status },
    });
  }

  const criteria = db
    .prepare('SELECT * FROM criteria WHERE task_id = ? AND required = 1')
    .all(taskId) as Array<{
    criterion_id: string;
    text: string;
    status: string;
    evidence_id: string | null;
  }>;

  let required_pass = 0;
  const now = Date.now();
  for (const c of criteria) {
    if (c.status !== 'pass' || !c.evidence_id) {
      gaps.push({
        code: 'required_criteria_unmet',
        message: `criterion not PASS with evidence: ${c.text}`,
        detail: { criterion_id: c.criterion_id, status: c.status },
      });
      continue;
    }
    const ev = db.prepare('SELECT * FROM evidence WHERE evidence_id = ?').get(c.evidence_id) as
      | { exit_code: number; timestamp: string; task_id: string }
      | undefined;
    if (!ev || ev.task_id !== taskId || ev.exit_code !== 0) {
      gaps.push({
        code: 'stale_or_missing_evidence',
        message: `evidence missing or non-zero for ${c.criterion_id}`,
        detail: { criterion_id: c.criterion_id, evidence_id: c.evidence_id },
      });
      continue;
    }
    const age = now - Date.parse(ev.timestamp);
    if (!Number.isFinite(age) || age > EVIDENCE_MAX_AGE_MS || age < 0) {
      gaps.push({
        code: 'stale_or_missing_evidence',
        message: `evidence stale for ${c.criterion_id}`,
        detail: { evidence_id: c.evidence_id, timestamp: ev.timestamp },
      });
      continue;
    }
    required_pass += 1;
  }

  if (criteria.length === 0) {
    gaps.push({
      code: 'required_criteria_unmet',
      message: 'no required criteria frozen — refuse DONE',
    });
  }

  const openUnits = db
    .prepare('SELECT unit_id, state FROM work_units WHERE task_id = ?')
    .all(taskId) as Array<{ unit_id: string; state: string }>;
  const blocking = openUnits.filter((u) => OPEN_UNIT_STATES.has(u.state));
  if (blocking.length > 0) {
    gaps.push({
      code: 'open_work_units',
      message: 'pending/in_progress/blocked units remain',
      detail: blocking,
    });
  }

  return {
    ok: gaps.length === 0,
    gaps,
    required_total: criteria.length,
    required_pass,
  };
}

/** Only path that may set DONE. */
export function completeTaskIfGatePasses(db: AfkDb, taskId: string): Result<AfkTaskRow> & { report: CompletionReport } {
  const report = evaluateCompletion(db, taskId);
  if (!report.ok) {
    return {
      ok: false,
      error: { code: 'gate_failed', message: 'completion gate rejected DONE', detail: report.gaps },
      report,
    };
  }
  // Move to READY_TO_DELIVER if still VERIFYING
  const task = getTask(db, taskId)!;
  if (task.status === 'VERIFYING') {
    const mid = transitionTask(db, taskId, 'READY_TO_DELIVER', { reason: 'gate_pre' });
    if (!mid.ok) return { ...mid, report };
  }
  const done = transitionTask(db, taskId, 'DONE', { allowDone: true, reason: 'completion_gate' });
  return { ...done, report };
}
