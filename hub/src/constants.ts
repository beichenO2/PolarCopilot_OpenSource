/** Agent is "alive" if last ping is within this window (UI green dot) */
export const ALIVE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Weekly GC window: all ephemeral data older than 7 days is purged.
 * Runs once per day at midnight.
 */
export const WEEKLY_GC_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Grace period after Hub startup before dead-agent purging begins */
export const STARTUP_GRACE_MS = 5 * 60 * 1000; // 5 min

/** How often the daily GC timer fires (24h, actual purge uses weekly threshold) */
export const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h (daily)

/** Poll throttle: minimum interval between GET /api/ui/prompts/:id calls from same agent */
export const PROMPT_POLL_MIN_INTERVAL_MS = 2000; // 2s
