# XJ → PolarCopilot RR Lossless Migration Design

## Objective

Move the complete local XJ communication state into PolarCopilot RR without changing any imported identifier, timestamp, sequence, body, status, or relationship. After import, a Cursor agent receiving the single user message `continue` must reconnect to the most recently active imported agent session, receive its conversation/task/topology context, and continue using that session's RR history and inbox. XJ may be removed only after the archive, import verification, idempotence check, resume test, and post-write routing test all pass.

## Chosen architecture

Use a dual representation:

1. `~/.rr-cursor/chat/compat/xj/raw/` contains a byte-for-byte copy of the complete XJ chat tree.
2. RR-native session/history/inbox/task/subagent files expose imported records to the existing RR store while keeping every imported XJ ID unchanged.
3. `~/.rr-cursor/chat/compat/xj/import-manifest.json` records source hashes, ID sets, reference checks, topology, normalized destinations, and verification results.

This is preferred over ID remapping because remapping breaks reconnect and correlation semantics. A raw-only archive is also insufficient because RR could not resume or route new messages. Replacing the whole RR store is rejected because it would endanger existing PolarCopilot data; import is additive and collision-safe.

## Compatibility mapping

| XJ source | RR representation | Preservation rule |
|---|---|---|
| `sessions/<sessionId>.json` | `sessions/<same sessionId>.json` | Native fields are populated for RR; the complete source object is retained under `compat.raw`; imported session/launch IDs and source status/times remain byte-identical in the raw mirror. |
| `history/<sessionId>.jsonl` | `history/<same sessionId>.jsonl` | `msgId`, `from`, `to`, `content`, and timestamp are unchanged; `seq`, `type`, `requireReply`, `suggestions`, and `subtask` remain in compatibility metadata. |
| `inbox/<sessionId>/<msgId>.json` | `inbox/<same sessionId>/<timestamp>-<same msgId>.json` | Message identity/body/routing fields are unchanged; filename changes are declared in the manifest. |
| `tasks/<taskId>.json` | `tasks/<same taskId>.json` | The complete task record is retained; task/master/target IDs, state, progress, result, and timestamps are unchanged. |
| `subagents/<sessionId>.json` | `subagents/<same sessionId>.json` plus session `isSubagent` | Exact marker retained; RR view derives availability without replacing source state. |
| `session-workspace.json` | raw mirror plus manifest workspace map | All 49 keys are retained, including the known workspace-only/session-only asymmetry. |
| `mcp-events.log` | raw mirror | All 1,471 event records are retained exactly but are not treated as writable RR messages. |

The topology manifest records `launch_claim`, `task_dispatch`, and `subtask_message` edges with their exact evidence IDs. No nonexistent XJ `parentId` is invented; parent/child structure is derived explicitly from launch IDs, task master/target fields, and message subtask peers.

## Import and idempotence

Dry-run parses every JSON/JSONL record, hashes every body, inventories every identifier-shaped field, validates timestamps/statuses and references, and calculates the expected normalized files without writing the RR root. Import uses atomic temporary files and refuses a destination collision unless it is an earlier import of the same source record. Existing RR-only files are never replaced. Re-running import must report zero inserted source records and leave imported/history IDs unique, including any later RR messages appended after migration.

## `continue` takeover

`register_session` keeps its seven-tool public contract. When called with `name: "continue"` and no explicit session/launch ID, it selects the imported non-pending agent session with the greatest source `lastActiveAt`. The response uses an `[RR_RESUME]` envelope and includes:

- the unchanged resumed session ID and launch ID;
- complete imported history for that session, in source sequence order;
- all tasks linked as master or target, with exact states/progress/results;
- the relevant subagent topology and source workspace record;
- the correct next instruction to call `wait_message` with that same session ID.

The resume operation may update RR runtime liveness, but the original XJ values remain immutable under `compat.raw`. A post-resume test must enqueue and consume a new message from the same session inbox, then save an agent reply into the same history without changing any imported message IDs.

## Cleanup hard gate

Cleanup requires a machine-readable gate report with all of the following true: archive checksum, source/raw tree hash equality, record counts, body hashes, ID sets, reference integrity, timestamp/status preservation, topology equivalence, idempotence, resume selection/context, and same-target inbox/history continuation.

Only then may cleanup remove:

- the active `xj-chat` MCP entry and XJ Cursor settings;
- XJ extension registry/state/secrets and the installed extension directory;
- `~/.xj-cursor`, `~/Desktop/XJ`, XJ/legacy Polar-XJ MCP caches, XJ logs, and XJ-bearing MCP backup files;
- XJ-specific Cursor state database keys and safe cache/MRU references.

PolarCopilot RR data, its offline archive, and `CURSOR_RR_MCP_*` lifecycle implementation are protected. Final scanning distinguishes active/config/cache residue from historical user-authored conversations so unrelated Cursor history is not destroyed accidentally.

## Verification evidence

The implementation must produce a JSON report in the migration task output directory containing counts, set/hash comparisons, archive checksum, selected resume session, idempotence outcome, cleanup gate, cleanup actions, and post-clean scan results. No success status may be written to `polaris.json` until fresh tests and live dry-run/import/resume checks pass.

