/**
 * Bridge: legacy file artifacts ↔ vNext completion gate.
 * Must NOT hollow the gate: no forced READY_TO_DELIVER, no auto-pass units,
 * no one-evidence-binds-all-criteria.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openAfkDb, type AfkDb } from './db.js';
import {
  addCriterion,
  addEvidence,
  bindCriterionEvidence,
  createTask,
  getTask,
  listActiveTasks,
  transitionTask,
} from './store.js';
import { completeTaskIfGatePasses, evaluateCompletion, type CompletionReport } from './completion-gate.js';
import { taskDir } from '../paths.js';

export class AfkCompletionGateError extends Error {
  readonly code = 'afk_completion_gate_failed';
  constructor(public readonly report: CompletionReport) {
    super(`afk_completion_gate_failed:${report.gaps.map((g) => g.code).join(',')}`);
    this.name = 'AfkCompletionGateError';
  }
}

function criteriaFile(taskId: string): string {
  return join(taskDir(taskId), 'CRITERIA.md');
}

function todoFile(taskId: string): string {
  return join(taskDir(taskId), 'TODO.md');
}

function evidenceFile(taskId: string): string {
  return join(taskDir(taskId), 'EVIDENCE.md');
}

export function parseCriteriaFile(content: string): string[] {
  if (/afk:criteria-unfrozen/.test(content) && !/afk:criteria-frozen/.test(content)) return [];
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out.filter((t) => t && !t.startsWith('#'));
}

export function parseOpenTodoItems(content: string): string[] {
  const open: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*[-*+]\s+\[\s\]\s+/.test(line)) {
      open.push(line.replace(/^\s*[-*+]\s+\[\s\]\s+/, '').trim());
    }
  }
  return open;
}

const HANDOFF_RE =
  /还需要.{0,12}(你|用户)?手动|请(你)?手动|需要(你|用户)手动|manual\s+(step|steps|configuration)/i;

function ensureTask(db: AfkDb, taskId: string, projectRoot: string): void {
  if (getTask(db, taskId)) return;
  createTask(db, {
    taskId,
    goal: taskId,
    projectRoot,
    surface: 'ide',
    status: 'PLANNING',
  });
}

function syncCriteria(db: AfkDb, taskId: string): number {
  const count = db.prepare('SELECT COUNT(*) AS c FROM criteria WHERE task_id = ?').get(taskId) as { c: number };
  if (count.c > 0) return count.c;
  if (!existsSync(criteriaFile(taskId))) return 0;
  const texts = parseCriteriaFile(readFileSync(criteriaFile(taskId), 'utf8'));
  for (const text of texts) addCriterion(db, taskId, text, true);
  return texts.length;
}

function materialDigest(taskId: string): string {
  const parts: string[] = [];
  for (const name of ['CRITERIA.md', 'TODO.md', 'EVIDENCE.md']) {
    const p = join(taskDir(taskId), name);
    if (existsSync(p)) parts.push(`${name}:${readFileSync(p, 'utf8')}`);
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

export interface GateEvidenceInput {
  command: string;
  exitCode: number;
  salient: string;
  /** Optional: bind to a specific criterion_id */
  criterionId?: string;
}

/**
 * Prepare vNext rows from files + optional per-criterion evidence, then evaluateCompletion.
 * Does not mutate task status into READY_TO_DELIVER and does not auto-pass work units.
 */
export function assertCanMarkDone(
  taskId: string,
  opts?: { projectRoot?: string; db?: AfkDb; evidence?: GateEvidenceInput | GateEvidenceInput[] },
): CompletionReport {
  const db = opts?.db ?? openAfkDb();
  ensureTask(db, taskId, opts?.projectRoot ?? '');
  const task = getTask(db, taskId)!;

  if (task.status !== 'VERIFYING' && task.status !== 'READY_TO_DELIVER') {
    // Allow one controlled step PLANNING/RUNNING → VERIFYING only when evidence supplied
    const evidences = opts?.evidence
      ? Array.isArray(opts.evidence)
        ? opts.evidence
        : [opts.evidence]
      : [];
    if (evidences.some((e) => e.exitCode === 0) && (task.status === 'RUNNING' || task.status === 'PLANNING')) {
      if (task.status === 'PLANNING') transitionTask(db, taskId, 'RUNNING', { reason: 'bridge_pre_verify' });
      transitionTask(db, taskId, 'VERIFYING', { reason: 'bridge_pre_verify' });
      transitionTask(db, taskId, 'READY_TO_DELIVER', { reason: 'bridge_pre_verify' });
    } else {
      return {
        ok: false,
        gaps: [
          {
            code: 'wrong_phase',
            message: `status ${task.status} — move to VERIFYING/READY_TO_DELIVER with real verify evidence first`,
            detail: { status: task.status },
          },
        ],
        required_total: 0,
        required_pass: 0,
      };
    }
  }

  const n = syncCriteria(db, taskId);
  if (n === 0) {
    return {
      ok: false,
      gaps: [{ code: 'required_criteria_unmet', message: 'no frozen criteria (CRITERIA.md empty or unfrozen)' }],
      required_total: 0,
      required_pass: 0,
    };
  }

  if (existsSync(todoFile(taskId))) {
    const open = parseOpenTodoItems(readFileSync(todoFile(taskId), 'utf8'));
    if (open.length > 0) {
      return {
        ok: false,
        gaps: [{ code: 'open_work_units', message: 'TODO.md has open checkbox items', detail: open.slice(0, 20) }],
        required_total: n,
        required_pass: 0,
      };
    }
  }

  if (existsSync(evidenceFile(taskId))) {
    const evText = readFileSync(evidenceFile(taskId), 'utf8');
    if (HANDOFF_RE.test(evText)) {
      return {
        ok: false,
        gaps: [{ code: 'handoff_language_forbidden', message: 'EVIDENCE.md contains handoff-to-user language' }],
        required_total: n,
        required_pass: 0,
      };
    }
  }

  const digest = materialDigest(taskId);
  const evidences = opts?.evidence
    ? Array.isArray(opts.evidence)
      ? opts.evidence
      : [opts.evidence]
    : [];

  const pending = db
    .prepare(`SELECT criterion_id FROM criteria WHERE task_id = ? AND (status != 'pass' OR evidence_id IS NULL)`)
    .all(taskId) as Array<{ criterion_id: string }>;

  if (pending.length > 0) {
    if (evidences.length === 0) {
      return {
        ok: false,
        gaps: [{ code: 'stale_or_missing_evidence', message: 'pending criteria lack bound evidence' }],
        required_total: n,
        required_pass: 0,
      };
    }
    // Strict: either 1:1 evidence list, or single evidence only when exactly one pending criterion
    if (evidences.length === 1 && pending.length === 1) {
      const e = evidences[0]!;
      if (e.exitCode !== 0) {
        return {
          ok: false,
          gaps: [{ code: 'stale_or_missing_evidence', message: 'evidence exit_code != 0' }],
          required_total: n,
          required_pass: 0,
        };
      }
      const id = addEvidence(db, {
        taskId,
        command: e.command,
        exitCode: e.exitCode,
        salient: e.salient,
        producerRole: 'done_bridge',
        artifactDigest: digest,
      });
      bindCriterionEvidence(db, pending[0]!.criterion_id, id, 'pass');
    } else if (evidences.length === pending.length) {
      for (let i = 0; i < pending.length; i++) {
        const e = evidences[i]!;
        if (e.exitCode !== 0) {
          return {
            ok: false,
            gaps: [{ code: 'stale_or_missing_evidence', message: `evidence[${i}] exit_code != 0` }],
            required_total: n,
            required_pass: 0,
          };
        }
        const id = addEvidence(db, {
          taskId,
          command: e.command,
          exitCode: e.exitCode,
          salient: e.salient,
          producerRole: 'done_bridge',
          artifactDigest: digest,
        });
        bindCriterionEvidence(db, pending[i]!.criterion_id, id, 'pass');
      }
    } else {
      return {
        ok: false,
        gaps: [
          {
            code: 'stale_or_missing_evidence',
            message: `evidence count ${evidences.length} must equal pending criteria ${pending.length} (no fan-out)`,
          },
        ],
        required_total: n,
        required_pass: 0,
      };
    }
  }

  // Work units: do NOT auto-pass. If any open unit exists, gate fails via evaluateCompletion.
  // If zero units, that is allowed only when all criteria already PASS with evidence.

  const report = evaluateCompletion(db, taskId);
  // Strengthen: evidence rows must carry current material digest when produced by bridge
  if (report.ok) {
    const rows = db
      .prepare(
        `SELECT e.artifact_digest FROM criteria c JOIN evidence e ON e.evidence_id = c.evidence_id
         WHERE c.task_id = ? AND c.required = 1`,
      )
      .all(taskId) as Array<{ artifact_digest: string | null }>;
    for (const row of rows) {
      if (row.artifact_digest && row.artifact_digest !== digest) {
        return {
          ok: false,
          gaps: [
            {
              code: 'stale_or_missing_evidence',
              message: 'evidence artifact_digest mismatch vs CRITERIA/TODO/EVIDENCE material',
              detail: { expected: digest, got: row.artifact_digest },
            },
          ],
          required_total: report.required_total,
          required_pass: report.required_pass,
        };
      }
    }
  }
  return report;
}

export function completeViaGate(
  taskId: string,
  opts?: { projectRoot?: string; db?: AfkDb; evidence?: GateEvidenceInput | GateEvidenceInput[] },
): { report: CompletionReport } {
  const db = opts?.db ?? openAfkDb();
  const report = assertCanMarkDone(taskId, { ...opts, db });
  if (!report.ok) throw new AfkCompletionGateError(report);
  const result = completeTaskIfGatePasses(db, taskId);
  if (!result.ok) throw new AfkCompletionGateError(result.report);
  if (listActiveTasks(db).some((t) => t.task_id === taskId)) {
    throw new Error('invariant_violation: DONE still active in vnext');
  }
  return { report: result.report };
}
