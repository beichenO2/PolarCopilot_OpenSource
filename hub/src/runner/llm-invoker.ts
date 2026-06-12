import type { AnswerPacket, EscalationPacket, QuestionPacket } from '../protocol/packets.js';
import { answerPacketSchema, escalationPacketSchema } from '../protocol/packets.js';

export type InvokeResult =
  | { type: 'answer'; value: AnswerPacket }
  | { type: 'escalation'; value: EscalationPacket }
  | { type: 'parse_error'; raw: string; error: string };

/** Maps question_type to the expected answer_type. */
const questionTypeToAnswerType: Record<string, string> = {
  implementation_task: 'implementation_result',
  review_task: 'review_result',
  verification_task: 'verification_result',
  decomposition_task: 'decomposition_result',
};

/**
 * Builds a prompt string from a QuestionPacket for LLM consumption.
 */
export function buildPrompt(question: QuestionPacket): string {
  const lines: string[] = [];

  lines.push(`# Task`);
  lines.push(`**Objective**: ${question.objective}`);
  lines.push(`**Reason**: ${question.reason}`);
  lines.push(`**Question Type**: ${question.question_type}`);
  lines.push(`**Expected Answer Type**: ${questionTypeToAnswerType[question.question_type] ?? question.question_type}`);
  lines.push('');

  // Scope
  if (question.scope) {
    lines.push(`## Scope`);
    if (question.scope.files_to_read?.length) {
      lines.push(`Files to read:`);
      for (const f of question.scope.files_to_read) lines.push(`- ${f}`);
    }
    if (question.scope.files_to_write?.length) {
      lines.push(`Files to write:`);
      for (const f of question.scope.files_to_write) lines.push(`- ${f}`);
    }
    if (question.scope.directories?.length) {
      lines.push(`Directories:`);
      for (const d of question.scope.directories) lines.push(`- ${d}`);
    }
    lines.push('');
  }

  // Constraints
  if (question.constraints?.length) {
    lines.push(`## Constraints`);
    for (const c of question.constraints) lines.push(`- ${c}`);
    lines.push('');
  }

  // Acceptance criteria
  if (question.acceptance?.length) {
    lines.push(`## Acceptance Criteria`);
    for (const a of question.acceptance) {
      const idTag = a.id ? `[${a.id}]` : '';
      lines.push(`${idTag} ${a.description}${a.required ? ' (required)' : ''}`);
      if ('command' in a && a.command) lines.push(`  Command: ${a.command}`);
    }
    lines.push('');
  }

  // Context
  if (question.context) {
    lines.push(`## Context`);
    if (question.context.project_summary) lines.push(`Project: ${question.context.project_summary}`);
    if (question.context.phase_summary) lines.push(`Phase: ${question.context.phase_summary}`);
    if (question.context.tech_stack) lines.push(`Tech Stack: ${question.context.tech_stack}`);
    if (question.context.recent_history?.length) {
      lines.push(`Recent History:`);
      for (const h of question.context.recent_history) lines.push(`- ${h}`);
    }
    if (question.context.non_goals?.length) {
      lines.push(`Non-goals:`);
      for (const n of question.context.non_goals) lines.push(`- ${n}`);
    }
    lines.push('');
  }

  // Output contract
  if (question.output_contract) {
    lines.push(`## Output Contract`);
    if (question.output_contract.must_include?.length) {
      lines.push(`Must include: ${question.output_contract.must_include.join(', ')}`);
    }
    if (question.output_contract.allowed_formats?.length) {
      lines.push(`Allowed formats: ${question.output_contract.allowed_formats.join(', ')}`);
    }
    lines.push('');
  }

  // Dependencies
  if (question.depends_on_questions?.length) {
    lines.push(`## Dependencies`);
    lines.push(`This question depends on: ${question.depends_on_questions.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parses raw LLM output into an InvokeResult.
 * Strips markdown code fences, detects AnswerPacket or EscalationPacket.
 */
export function parseLlmOutput(raw: string): InvokeResult {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { type: 'parse_error', raw, error: 'no JSON object found in empty string' };
  }

  // Strip markdown code fences
  let jsonStr = trimmed;
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Try to find JSON object
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { type: 'parse_error', raw, error: 'no JSON object found in input' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { type: 'parse_error', raw, error: `JSON parse error: ${(e as Error).message}` };
  }

  // Check if it looks like an AnswerPacket (has answer_type)
  if ('answer_type' in parsed) {
    try {
      answerPacketSchema.parse(parsed);
      return { type: 'answer', value: parsed as AnswerPacket };
    } catch {
      return { type: 'parse_error', raw, error: 'answer parse failed' };
    }
  }

  // Check if it looks like an EscalationPacket (has escalation_id or blocker_type)
  if ('escalation_id' in parsed || 'blocker_type' in parsed) {
    try {
      escalationPacketSchema.parse(parsed);
      return { type: 'escalation', value: parsed as EscalationPacket };
    } catch {
      return { type: 'parse_error', raw, error: 'escalation parse failed' };
    }
  }

  return { type: 'parse_error', raw, error: 'JSON is neither AnswerPacket nor EscalationPacket' };
}
