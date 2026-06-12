import { z } from 'zod';

const sotaDiffFileSchema = z.object({
  path: z.string().describe('Repo-relative file path'),
  op: z.enum(['create', 'modify', 'delete']),
  lines_changed: z.number().int().min(0),
});

export const hubSotaDiffRecordInputSchema = z.object({
  agent_id: z.string(),
  git_commit: z.string().optional().describe('Git commit hash, if available'),
  intent: z.string().describe('Why this change was made'),
  files: z.array(sotaDiffFileSchema).min(1),
  summary: z.string().describe('One-line summary of the change'),
});

export const hubSotaDiffQueryInputSchema = z.object({
  file_path: z.string().optional().describe('Filter by file path (substring match)'),
  agent_id: z.string().optional().describe('Filter by agent'),
  limit: z.number().int().min(1).max(100).default(20),
  since_hours: z.number().min(0).default(24).describe('Look back N hours'),
});

export const hubSotaDiffCheckConflictInputSchema = z.object({
  agent_id: z.string(),
  files: z.array(z.string()).min(1).describe('Repo-relative file paths about to be modified'),
  since_hours: z.number().min(0).default(24),
});

export type HubSotaDiffRecordInput = z.infer<typeof hubSotaDiffRecordInputSchema>;
export type HubSotaDiffQueryInput = z.infer<typeof hubSotaDiffQueryInputSchema>;
export type HubSotaDiffCheckConflictInput = z.infer<typeof hubSotaDiffCheckConflictInputSchema>;
