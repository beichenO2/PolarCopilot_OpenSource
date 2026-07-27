# XJ → PolarCopilot RR Lossless Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import all XJ local state into RR with exact IDs and lossless compatibility metadata, prove one-word `continue` takeover, then remove XJ only after a machine-verifiable gate passes.

**Architecture:** Add a tested XJ parser/importer beside the existing RR file store. Preserve an immutable raw mirror and expose additive RR-native compatibility records; resume the latest imported agent through the existing `register_session` tool. Use a separate guarded cleanup utility only after all migration and takeover assertions pass.

**Tech Stack:** Node.js 22, TypeScript, Vitest, MCP SDK, atomic JSON/JSONL files, macOS Cursor configuration and SQLite state.

---

The current checkout contains user-owned uncommitted RR work. This plan intentionally omits automatic commits so those changes are not accidentally bundled or rewritten.

### Task 1: Lossless source audit and normalization contract

**Files:**
- Create: `hub/tests/rr/xj-migration.test.ts`
- Create: `hub/src/rr/xj-migration.ts`
- Modify: `hub/src/rr/types.ts`

- [ ] **Step 1: Write failing parser tests**

Create fixtures containing an agent session, pending launch partner, messages with `seq/subtask/requireReply/suggestions`, an inbox record, a completed task, a subagent marker, workspace entries, and event records. Assert exact source counts, `msgId/taskId/sessionId/launchId` sets, body SHA-256 sets, timestamp/status values, and `launch_claim/task_dispatch/subtask_message` topology edges.

- [ ] **Step 2: Verify RED**

Run `npm --prefix hub test -- --run tests/rr/xj-migration.test.ts` from the repository root. Expected: module import or unimplemented parser assertions fail for the intended missing behavior.

- [ ] **Step 3: Implement the minimal parser**

Export these interfaces and functions:

```ts
export interface XjAudit { counts: Record<string, number>; idSets: Record<string, string[]>; bodyHashes: string[]; references: XjReferenceReport; topology: XjTopology; latestAgentSessionId: string }
export function auditXjSource(sourceRoot: string): XjAudit;
export function planXjImport(sourceRoot: string, rrRoot: string): XjImportPlan;
```

Parse without mutation, sort set outputs deterministically, reject malformed JSON/duplicate IDs/broken required references, and retain the one known workspace/session asymmetry as an explicit optional relation rather than a failure.

- [ ] **Step 4: Verify GREEN**

Run the focused test and confirm every parser/topology assertion passes.

### Task 2: Additive, atomic, idempotent import

**Files:**
- Modify: `hub/tests/rr/xj-migration.test.ts`
- Modify: `hub/src/rr/xj-migration.ts`
- Modify: `hub/src/rr/types.ts`
- Modify: `hub/src/rr/store.ts`

- [ ] **Step 1: Write failing import tests**

Assert that import creates a byte-identical `compat/xj/raw` mirror, writes native compatibility records using the same XJ IDs, preserves complete raw objects, never replaces a pre-existing RR session/history, and reports a collision when the same destination ID has unrelated content.

- [ ] **Step 2: Verify RED**

Run the focused suite. Expected: missing import function and current `safeSessionId` rejection of `xj-mcp-agent-*` fail.

- [ ] **Step 3: Implement minimal additive import**

Export:

```ts
export function importXjToRr(plan: XjImportPlan): XjImportResult;
export function verifyXjImport(sourceRoot: string, rrRoot: string): XjVerificationReport;
```

Accept RR UUID IDs plus validated XJ agent/pending IDs in file paths. Store exact source objects under compatibility metadata, use original message/task IDs, write atomically, and make later runs skip already imported records by source record hash and message ID.

- [ ] **Step 4: Verify idempotence GREEN**

Import the fixture twice, append one RR-native post-migration message, import a third time, and assert imported IDs remain unique and the new RR message survives.

### Task 3: One-word `continue` resume semantics

**Files:**
- Modify: `hub/tests/rr/xj-migration.test.ts`
- Modify: `hub/tests/rr/mcp-server.test.ts`
- Modify: `hub/src/rr/store.ts`
- Modify: `hub/src/rr/mcp-server.ts`
- Modify: `hub/src/rr/types.ts`

- [ ] **Step 1: Write failing resume tests**

Call `register_session` with `{name: "continue"}` after fixture import. Assert `[RR_RESUME]`, the exact latest source session/launch IDs, all source history bodies, linked tasks with unchanged states, topology edges, workspace context, and the same-ID `wait_message` instruction.

- [ ] **Step 2: Write failing continuation routing test**

After resume, enqueue a uniquely tagged message into the resumed session, consume it through `wait_message`, reply, and assert both operations target that same XJ session's inbox/history. Assert all imported message IDs still match the source set.

- [ ] **Step 3: Verify RED**

Run both RR test files. Expected: `continue` currently creates a new RR UUID session or lacks resume context.

- [ ] **Step 4: Implement resume**

Add `resumeLatestImportedSession()` and a deterministic `[RR_RESUME]` renderer. Select only imported `xj-mcp-agent-*` sessions using immutable source `lastActiveAt`; never select pending sessions or newly generated RR sessions.

- [ ] **Step 5: Verify GREEN and existing seven-tool contract**

Confirm the focused suites pass and `listTools()` still returns exactly the original seven tools.

### Task 4: Migration CLI, live dry-run, import and evidence report

**Files:**
- Create: `hub/src/rr/xj-migration-cli.ts`
- Modify: `hub/package.json`
- Create at runtime: task output `xj-migration-report.json`

- [ ] **Step 1: Write CLI behavior tests before implementation**

Test `--dry-run`, `--import`, `--verify`, explicit source/RR roots, non-zero exit on collision or verification mismatch, and JSON report output.

- [ ] **Step 2: Implement CLI and package scripts**

Add `rr:xj:dry-run`, `rr:xj:import`, and `rr:xj:verify` scripts using `tsx src/rr/xj-migration-cli.ts`. The CLI must not print message bodies or credential values.

- [ ] **Step 3: Run live dry-run**

Run against `~/.xj-cursor/chat` and `~/.rr-cursor/chat`. Require 49 sessions, 137 histories, 7 inbox messages, 15 tasks, 7 subagents, matching body/ID sets, and zero broken required references.

- [ ] **Step 4: Run live import and verify**

Import, verify, import again, and verify that the second run adds zero source records and no existing RR-only record is changed.

### Task 5: Cleanup gate and cleanup implementation

**Files:**
- Create: `hub/tests/rr/xj-cleanup.test.ts`
- Create: `hub/src/rr/xj-cleanup.ts`
- Create: `hub/src/rr/xj-cleanup-cli.ts`
- Modify: `hub/package.json`

- [ ] **Step 1: Write failing gate tests**

Assert cleanup refuses when any archive/data/body/ID/reference/status/topology/idempotence/resume/routing check is false or absent. Assert protected RR paths and the offline archive can never enter the deletion plan.

- [ ] **Step 2: Write failing fixture cleanup tests**

Use temporary Cursor/XJ layouts and SQLite stores. Assert only `xj-chat`, XJ settings, XJ extension/state/secrets, XJ/legacy cache/log directories, XJ data, Desktop XJ artifacts, and named backup files are removed. Assert unrelated MCP entries/settings/history and `rr-chat` remain byte-equivalent.

- [ ] **Step 3: Verify RED, implement, then verify GREEN**

Implement `planXjCleanup`, `applyXjCleanup`, and `scanXjResidue`. Use atomic JSON writes, SQLite transactions, exact allowlisted paths/keys, and a protected-path denylist.

### Task 6: Governed runtime validation and live cleanup

**Files:**
- Modify: `polaris.json`
- Create at runtime: task output `xj-cleanup-report.json`

- [ ] **Step 1: Run runtime-governance preflight**

Read the runtime contract and run the governance audit before any Cursor/MCP lifecycle action. Use PolarProcess for Hub lifecycle actions; the stdio smoke command remains transient.

- [ ] **Step 2: Run full migration gate**

Run focused tests, full RR tests, TypeScript build, live source/import verification, MCP in-memory resume/routing E2E, and transient stdio smoke. Write the all-true gate report and verify its archive checksum freshly.

- [ ] **Step 3: Remove active XJ configuration before process teardown**

Apply the cleanup utility atomically. Gracefully quit/reopen Cursor only if needed to release the installed extension/MCP process; do not use direct signals or unmanaged service commands.

- [ ] **Step 4: Post-clean full scan**

Confirm no active XJ extension, MCP entry/process, XJ setting/secret, named cache/log/data path, launch item, or XJ lifecycle marker remains. Confirm RR imported data, archive, `rr-chat`, and `CURSOR_RR_MCP_*` implementation remain.

- [ ] **Step 5: Update SSoT with fresh evidence**

Replace the obsolete “XJ is never migrated” behavior with the exact compatibility/import/continue behavior. Mark tested/done only after every fresh command exits successfully.

### Task 7: Independent review and final verification

**Files:**
- Review: all files above plus external cleanup reports

- [ ] **Step 1: Request a read-only correctness/security review**

Provide the requirement list, touched files, archive/gate reports, and test commands to a reviewer. Fix every critical or important issue with a new failing test first.

- [ ] **Step 2: Run final fresh verification**

Repeat tests, build, archive checksum, imported source equivalence, `continue` resume/routing, idempotence, post-clean scan, RR config/data protection, and runtime audit.

- [ ] **Step 3: Report exact evidence**

Return migration counts, selected latest session ID, archive path/checksum, test totals, cleanup list, retained protected paths, and the only remaining user action (ideally typing `continue` once in Cursor).
