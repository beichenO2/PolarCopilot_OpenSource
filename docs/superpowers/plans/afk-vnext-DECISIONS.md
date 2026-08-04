# AFK vNext DECISIONS (never-ask log)

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | DB path `~/.polar-copilot/afk/afk.db` | Prompt default; isolates from Hub main DB; override `POLAR_AFK_DB` |
| D2 | Module under `hub/src/rr/afk/vnext/` | Compat with in-flight fleet-10 edits; strangler fig |
| D3 | Raw better-sqlite3 transactions for state machine; drizzle schema optional mirror | Invariants need explicit SQL transactions; Hub already has both |
| D4 | IDE stop hook script lives in repo `hub/scripts/afk-stop-hook.sh`; user hooks.json gains entry in Step3 with backup | Reversible; discovery spike not auto-installed |
| D5 | Budget unavailable → exec concurrency 1 (not admission floor 10) | Prompt hard requirement; overrides current fleet floor |
| D6 | Status model: DRAFT→PLANNING→RUNNING→VERIFYING→READY_TO_DELIVER→DONE + PAUSED/BLOCKED/NEEDS_HUMAN/CANCELLED/FAILED_RECOVERABLE/QUEUED | Prompt; map legacy READY→RUNNING etc. on migrate |
| D7 | CLI resume uses `--resume <chatId>` from create-chat/native_handle | Proven in `--help` |
| D8 | Do not push / PR unless asked | Prompt + user git rules |
| D9 | composer-superpowers remains mandatory quality protocol; outer task loop unbounded, inner unit FIX≤3 | Prompt |
| D10 | Removal milestone for file SSoT: after Step8 E2E + migrate report | Explicit compat sunset |
