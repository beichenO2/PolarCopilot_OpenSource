# ADR: AFK vNext — Single Control Plane, Dual Executors

- **Status**: Accepted (2026-07-31)
- **Deciders**: PolarCopilot AFK vNext orchestrator (this run)
- **Supersedes**: file-flag SSoT (`ACTIVE`/`PAUSE`/`DONE` + `index.json` as runtime truth); IDE default path via `rr-chat` wait_message; Web path via Hub MCP mailbox

## Context

AFK today conflates surface, executor, discipline, and control-plane. File-based state allows `active∧done`, skip-gate DONE, and cross-task Subagent pool contamination. MCP mailbox was used as the IDE infinite loop transport.

Discovery (see `afk-vnext-discovery.md`) proved:

1. Cursor stop hooks can `followup_message` the **same** `conversation_id`.
2. `cursor-agent` CLI has native `--resume [chatId]` / `--continue`.
3. Hub already depends on `better-sqlite3` + drizzle.

## Decision

1. **SQLite WAL** at `~/.polar-copilot/afk/afk.db` (override `POLAR_AFK_DB`) is the only runtime SSoT for task/run/unit/criteria/evidence/events.
2. Human artifacts (`PLAN.md`, `CRITERIA.md`, `TODO.md`, `DECISIONS.md`, `EVIDENCE.md`) remain per-task files but **never** independently mutate run status.
3. **Surfaces**: `ide` | `web`. **Executors**: `cursor-native` | `cursor-cli`.
4. IDE: bind task to `conversation_id`+cwd; native Subagent IDs stored in registry only; stop hook continues until completion gate.
5. Web: PolarProcess supervises `cursor-agent`; REST/SSE observe; no Hub message MCP.
6. `DONE` only via transactional `evaluateCompletion(taskId)` success.
7. AFK control-plane MCP (`rr-chat`, `hub-agent-*`, `xj-chat`, message-only `my-mcp-*`) feature-flagged off by default (phase 1); capability MCPs retained.
8. User skills: only `afk` (router), `afk-start`, `afk-solo`. Retire `afk-go` as user mode.
9. Admission (register) ≠ execution concurrency. Budget down → exec concurrency 1, never drop tasks / never floor=10.
10. Compat layer for old `index.json`/flags has explicit removal milestone: **after Step 8 E2E green + migrate dry-run report**.

## Consequences

- New module tree: `hub/src/rr/afk/vnext/*`
- Facades in `afk-service` / CLI gradually call vnext; file writers become projection/export
- Orchestrator renames toward AFK supervisor (transport-neutral)
- Tests must cover invariants, gate rejection, cross-task isolation — not only inject fan-out

## Migration table (summary)

| From | To | Phase |
|------|-----|-------|
| `tasks/index.json` active/done | `tasks` + `runs` tables | Step1 migrate dry-run → Step7 cutover |
| `state.json` status | `tasks.status` + events | Step1–2 |
| `ACTIVE/PAUSE/DONE` flags | ignore for runtime; archive | Step7 |
| rr-chat wait loop (IDE) | stop hook + native agent | Step3 |
| Hub MCP mailbox (Web) | CLI executor + SSE | Step4 |
| `afk-go` / infinite-mcp.md | archived docs | Step6 |
| `masterSessionId` global | per-run `native_handle` / bindings | Step3–4 |

## Deletion / disable table

| Artifact | Action | Milestone |
|----------|--------|-----------|
| Default `rr-chat` install | stop auto-install; flag off | Step7 |
| `hub-agent-*` as AFK bus | not used by AFK path | Step7 |
| `xj-chat` | already cleanup path; ensure disabled | Step7 |
| `my-mcp-*` message clones | disable if audit-only-message | Step7 |
| Runtime reads of ACTIVE/PAUSE/DONE | remove after migrate | post-Step8 |
| User-facing `afk-go` | skill → retired stub | Step6 |
