/**
 * Evolution signal detection hook script.
 * 
 * Used by Cursor hooks (afterFileEdit/stop) to automatically detect
 * and submit evolution signals to the Hub.
 *
 * Signal detection patterns:
 * 1. Error patterns in Agent output (stderr, exit codes)
 * 2. Repeated file edits to the same location
 * 3. SKILL/Rule file modifications (potential ambiguity signals)
 * 4. API endpoint changes (potential API misuse signals)
 */

const SIGNAL_PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  title: (match: RegExpMatchArray) => string;
  details: (match: RegExpMatchArray, context: string) => string;
}> = [
  {
    type: 'error_pattern',
    pattern: /EADDRINUSE.*:(\d+)/i,
    title: (m) => `Port ${m[1]} already in use`,
    details: (m, ctx) => `EADDRINUSE on port ${m[1]}. Context: ${ctx.slice(0, 200)}`,
  },
  {
    type: 'error_pattern',
    pattern: /ENOENT.*['"]([\w/.]+)['"]/i,
    title: (m) => `File not found: ${m[1]}`,
    details: (m, ctx) => `ENOENT for ${m[1]}. Context: ${ctx.slice(0, 200)}`,
  },
  {
    type: 'api_misuse',
    pattern: /GET \/api\/ui\/prompts[^/]/i,
    title: () => 'Potential prompt list API misuse for polling',
    details: (_m, ctx) => `Detected GET /api/ui/prompts (list) which only returns pending. Use /api/ui/prompts/:id instead. Context: ${ctx.slice(0, 200)}`,
  },
  {
    type: 'error_pattern',
    pattern: /not_registered|session.*expired|agent_id_collision/i,
    title: (m) => `Hub session issue: ${m[0]}`,
    details: (m, ctx) => `Hub session error: ${m[0]}. Context: ${ctx.slice(0, 200)}`,
  },
  {
    type: 'skill_ambiguity',
    pattern: /SKILL\.md|pc-solo-web|pc-principles/i,
    title: () => 'SKILL file modification detected',
    details: (_m, ctx) => `SKILL-related file was modified. Review for potential ambiguity. Context: ${ctx.slice(0, 200)}`,
  },
];

export function detectSignals(text: string, source: string): Array<{
  type: string;
  source: string;
  title: string;
  details: string;
}> {
  const results: Array<{
    type: string;
    source: string;
    title: string;
    details: string;
  }> = [];

  for (const p of SIGNAL_PATTERNS) {
    const match = text.match(p.pattern);
    if (match) {
      results.push({
        type: p.type,
        source,
        title: p.title(match),
        details: p.details(match, text),
      });
    }
  }

  return results;
}

export function buildHooksJson(hubPort: number): {
  version: number;
  hooks: Record<string, Array<{ command: string; timeout?: number }>>;
} {
  return {
    version: 1,
    hooks: {
      sessionStart: [
        {
          command: `curl -s http://127.0.0.1:${hubPort}/api/evolution/signals -X POST -H "Content-Type: application/json" -d '{"type":"user_feedback","source":"cursor:session","title":"New Cursor session started","details":"Agent session started, monitoring for signals."}'`,
          timeout: 3,
        },
      ],
      stop: [
        {
          command: `curl -s http://127.0.0.1:${hubPort}/api/evolution/signals -X POST -H "Content-Type: application/json" -d '{"type":"user_feedback","source":"cursor:session","title":"Cursor session ended","details":"Agent session completed."}'`,
          timeout: 5,
        },
      ],
    },
  };
}
