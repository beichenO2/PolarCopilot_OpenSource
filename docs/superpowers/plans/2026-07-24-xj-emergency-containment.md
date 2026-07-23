# XJ-Cursor Emergency Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove XJ Prompt/request-context injection and MCP lifecycle bypasses while retaining the installed XJ extension, account/NoQuota online features, and forensic chat data.

**Architecture:** Add a fixture-tested Node.js containment utility under PolarCopilot that performs pure in-memory transforms first, verifies exact marker counts and backup relationships, snapshots every touched file, then atomically writes settings, MCP config, and Cursor resources. Apply it once to the installed Cursor, fully restart Cursor, and verify both disk state and the newly loaded process state.

**Tech Stack:** Node.js 22 built-ins (`node:test`, `fs`, `crypto`), JSON configuration, minified Cursor JavaScript line restoration, macOS `codesign`/`osascript`, existing Polar runtime audit.

---

## File map

- Create `tools/xj-containment/core.cjs`: pure parsing, validation, hashing, and transformation functions with no filesystem writes.
- Create `tools/xj-containment/cli.cjs`: snapshot, dry-run, apply, rollback, and verify commands; all writes are atomic and secret-safe.
- Create `tools/xj-containment/core.test.cjs`: Node built-in unit tests for settings, MCP removal, marker restoration, and refusal paths.
- Create `tools/xj-containment/live-layout.test.cjs`: read-only contract test against the currently installed XJ/Cursor layout and hashes.
- Modify `hub/package.json`: expose unit-test, pre/post live-layout, inspect, and verify commands without adding dependencies.
- Modify `polaris.json`: add the emergency-containment feature status/evidence without changing runtime service ownership.
- Runtime targets, modified only by `cli.cjs apply` after all tests pass:
  - `~/Library/Application Support/Cursor/User/settings.json`
  - `~/.cursor/mcp.json`
  - `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`
  - `/Applications/Cursor.app/Contents/Resources/app/out/vs/workbench/workbench.glass.main.js`
  - `/Applications/Cursor.app/Contents/Resources/app/out/vs/code/electron-utility/mcpProcess/mcpProcessMain.js`

### Task 1: Add RED tests for pure containment transforms

**Files:**
- Create: `tools/xj-containment/core.test.cjs`
- Test: `tools/xj-containment/core.test.cjs`

- [ ] **Step 1: Write failing tests**

Create tests that import functions which do not yet exist:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  updateSettings,
  removeXjChat,
  restoreLineByMarker,
  assertNoInjectionMarkers,
} = require('./core.cjs');

test('updateSettings disables only XJ injection/install switches', () => {
  const input = {
    'xjCursor.update.autoCheck': true,
    'xjCursor.mcpStable.enabled': true,
    unrelated: { keep: 'exactly' },
  };
  const output = updateSettings(input);
  assert.equal(output['xjCursor.rules.enabled'], false);
  assert.equal(output['xjCursor.mcpStable.enabled'], false);
  assert.equal(output['xjCursor.update.autoInstall'], false);
  assert.equal(output['xjCursor.update.autoCheck'], true);
  assert.deepEqual(output.unrelated, input.unrelated);
});

test('removeXjChat removes only the xj-chat server', () => {
  const input = {
    mcpServers: {
      alpha: { command: 'alpha' },
      'xj-chat': { command: 'xj' },
      omega: { url: 'https://example.invalid/mcp' },
    },
  };
  const { config, removed } = removeXjChat(input);
  assert.deepEqual(removed, { command: 'xj' });
  assert.deepEqual(config.mcpServers, {
    alpha: { command: 'alpha' },
    omega: { url: 'https://example.invalid/mcp' },
  });
});

test('restoreLineByMarker replaces only the marked current line', () => {
  const current = ['head', 'before /*CURSOR_MCP_LEASE_GUARD*/ return after', 'tail'].join('\n');
  const backup = ['head', 'before originalLeaseBehavior() after', 'tail'].join('\n');
  assert.equal(
    restoreLineByMarker(current, backup, 'CURSOR_MCP_LEASE_GUARD'),
    backup,
  );
});

test('restoreLineByMarker refuses zero or multiple marker occurrences', () => {
  assert.throws(() => restoreLineByMarker('clean', 'clean', 'MARK'), /exactly once/);
  assert.throws(
    () => restoreLineByMarker('MARK\nMARK', 'a\nb', 'MARK'),
    /exactly once/,
  );
});

test('assertNoInjectionMarkers rejects every known marker', () => {
  for (const marker of [
    'CURSOR_AGENTRULES_NP_START',
    'CURSOR_AGENTRULES_NP_END',
    'CURSOR_MCP_CREATE_DEDUPE',
    'CURSOR_MCP_LEASE_GUARD',
    'CURSOR_MCP_UNSUB_GRACE',
    'CURSOR_MCP_SANDBOX_GUARD',
  ]) {
    assert.throws(() => assertNoInjectionMarkers(`x ${marker} y`), new RegExp(marker));
  }
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd ~/Polarisor/PolarCopilot
node --test tools/xj-containment/core.test.cjs
```

Expected: FAIL with `Cannot find module './core.cjs'`.

- [ ] **Step 3: Commit the RED tests**

```bash
git add tools/xj-containment/core.test.cjs
git commit -m "test: specify XJ containment transforms"
```

### Task 2: Implement pure transforms and make unit tests GREEN

**Files:**
- Create: `tools/xj-containment/core.cjs`
- Modify: `tools/xj-containment/core.test.cjs`
- Test: `tools/xj-containment/core.test.cjs`

- [ ] **Step 1: Implement settings and MCP transforms**

Add immutable JSON helpers:

```js
const crypto = require('node:crypto');

const MARKERS = [
  'CURSOR_AGENTRULES_NP_START',
  'CURSOR_AGENTRULES_NP_END',
  'CURSOR_MCP_CREATE_DEDUPE',
  'CURSOR_MCP_LEASE_GUARD',
  'CURSOR_MCP_UNSUB_GRACE',
  'CURSOR_MCP_SANDBOX_GUARD',
];

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function updateSettings(input) {
  const output = cloneJson(input);
  output['xjCursor.rules.enabled'] = false;
  output['xjCursor.mcpStable.enabled'] = false;
  output['xjCursor.update.autoInstall'] = false;
  return output;
}

function removeXjChat(input) {
  const config = cloneJson(input);
  if (!config.mcpServers || !Object.hasOwn(config.mcpServers, 'xj-chat')) {
    throw new Error('mcpServers.xj-chat must exist exactly once before containment');
  }
  const removed = config.mcpServers['xj-chat'];
  delete config.mcpServers['xj-chat'];
  return { config, removed };
}
```

- [ ] **Step 2: Implement marker-based line restoration**

Use the clean backup line, never regex-rewrite the 36K embedded Prompt:

```js
function count(source, needle) {
  return source.split(needle).length - 1;
}

function restoreLineByMarker(current, backup, marker) {
  if (count(current, marker) !== 1) {
    throw new Error(`${marker} must occur exactly once in current content`);
  }
  if (count(backup, marker) !== 0) {
    throw new Error(`${marker} must not occur in backup content`);
  }
  const currentLines = current.split('\n');
  const backupLines = backup.split('\n');
  if (currentLines.length !== backupLines.length) {
    throw new Error(`${marker} line-count mismatch`);
  }
  const index = currentLines.findIndex((line) => line.includes(marker));
  currentLines[index] = backupLines[index];
  return currentLines.join('\n');
}

function assertNoInjectionMarkers(source) {
  for (const marker of MARKERS) {
    if (source.includes(marker)) throw new Error(`remaining marker: ${marker}`);
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  MARKERS,
  updateSettings,
  removeXjChat,
  restoreLineByMarker,
  assertNoInjectionMarkers,
  sha256,
};
```

- [ ] **Step 3: Add a combined desktop transform test**

Test that the rule line comes from `cursor-cost.bak`, while MCP lines come from `cursor-mcp.bak`, and the result contains none of the six markers. Use three-line fixtures with all desktop markers.

- [ ] **Step 4: Run unit tests and verify GREEN**

Run:

```bash
node --test tools/xj-containment/core.test.cjs
```

Expected: all tests PASS, zero failures.

- [ ] **Step 5: Commit pure transforms**

```bash
git add tools/xj-containment/core.cjs tools/xj-containment/core.test.cjs
git commit -m "feat: add verified XJ containment transforms"
```

### Task 3: Add the read-only live-layout contract test

**Files:**
- Create: `tools/xj-containment/live-layout.test.cjs`
- Test: `tools/xj-containment/live-layout.test.cjs`

- [ ] **Step 1: Write the current-layout assertions**

The test must only read files and require `XJ_CONTAINMENT_EXPECT=pre` or `post`. In `pre` mode assert:

```js
const EXPECTED_HASHES = {
  desktopCurrent: '3872d68baa3823075425d1d7f37bae4d0c1363bdc0f779332347a214192f73f5',
  desktopCostBackup: '11c0dad16ae930ab2419c293509d084289afe28bb3da8ea4edefc00eeb1cb12a',
  desktopMcpBackup: '7b040fbaaf8ad511ea0dac6449030840893061c5ec294daafe130299443dd6d8',
  glassCurrent: 'b6efde714cb0ad32f0aedd00bdd0f59638816885fe5eb2010342b08bafdd67da',
  glassBackup: 'f1d5bd4b60ae844fb9990fd499ca1ea176be195f40fbd5ab78303604e14431d6',
  mcpCurrent: '79a6413ee4df813da6e84c4a0c3b8c35e1d6a04c295acd18a7f67d79ccc8efad',
  mcpBackup: '29898e2e0d0b199cb65e4079317f7f1f76e52139f76f38f6811af43a4454d0b2',
};
```

Also assert in `pre` mode:

- current desktop has one start/end rule marker, one create marker, one lease marker;
- current glass has one create marker and one lease marker;
- current mcpProcess has one grace marker and one sandbox marker;
- cost backup has none of the six markers;
- MCP backups have no `CURSOR_MCP_*` markers;
- `settings.json` and `mcp.json` parse as JSON;
- `mcpServers.xj-chat` exists before apply;
- `~/.xj-cursor/chat` exists and capture its pre-apply path set. Treat session files and `mcp-events.log` as externally mutable while the live XJ process is still running; verification requires that no pre-existing path was deleted, not byte-for-byte equality.

In `post` mode assert that desktop equals `desktopCostBackup`, glass equals `glassBackup`, mcpProcess equals `mcpBackup`, all injection markers are absent, settings contain the three false values, and `mcpServers.xj-chat` is absent. Any other environment value must fail rather than silently choose a mode.

- [ ] **Step 2: Run the live-layout test**

Run:

```bash
XJ_CONTAINMENT_EXPECT=pre node --test tools/xj-containment/live-layout.test.cjs
```

Expected: PASS. Any hash or marker mismatch aborts the hotfix and requires a new forensic diff.

- [ ] **Step 3: Commit the contract test**

```bash
git add tools/xj-containment/live-layout.test.cjs
git commit -m "test: lock current XJ patch layout"
```

### Task 4: Implement snapshot, dry-run, apply, rollback, and verify CLI

**Files:**
- Create: `tools/xj-containment/cli.cjs`
- Modify: `hub/package.json`
- Test: `tools/xj-containment/core.test.cjs`

- [ ] **Step 1: Add CLI argument handling**

Support exactly these commands:

```text
node tools/xj-containment/cli.cjs inspect
node tools/xj-containment/cli.cjs apply
node tools/xj-containment/cli.cjs verify --backup <absolute-path>
node tools/xj-containment/cli.cjs rollback --backup <absolute-path>
```

Unknown commands or relative backup paths exit non-zero without writing.

- [ ] **Step 2: Implement snapshot with restrictive permissions**

Before applying, create `~/Desktop/XJ/hotfix-backup-YYYYMMDDTHHMMSS/` with mode `0700`. Copy each target and source backup with mode `0600`. Write `manifest.json` containing source path, relative backup path, SHA-256, size, mtime, and mode; do not serialize file content or JSON values into the manifest.

- [ ] **Step 3: Build and validate every output in memory**

Apply transformations in this order:

```js
desktop = restoreLineByMarker(desktop, desktopCostBackup, 'CURSOR_AGENTRULES_NP_START');
desktop = restoreLineByMarker(desktop, desktopMcpBackup, 'CURSOR_MCP_CREATE_DEDUPE');
desktop = restoreLineByMarker(desktop, desktopMcpBackup, 'CURSOR_MCP_LEASE_GUARD');

glass = restoreLineByMarker(glass, glassBackup, 'CURSOR_MCP_CREATE_DEDUPE');
glass = restoreLineByMarker(glass, glassBackup, 'CURSOR_MCP_LEASE_GUARD');

mcpProcess = restoreLineByMarker(mcpProcess, mcpBackup, 'CURSOR_MCP_UNSUB_GRACE');
// Both mcpProcess markers are on the same minified line. After the first line
// replacement, SANDBOX_GUARD is already gone; assert that fact instead of
// attempting a second replacement.
assertNoInjectionMarkers([desktop, glass, mcpProcess].join('\n'));
```

Validate before any write:

- transformed desktop equals `desktopCostBackup` byte-for-byte;
- transformed glass equals `glassBackup` byte-for-byte;
- transformed mcpProcess equals `mcpBackup` byte-for-byte;
- settings contain the three false values;
- the only removed MCP key is `xj-chat`;
- no pre-existing XJ chat-data path is deleted; the tool never writes under `~/.xj-cursor/chat`.

- [ ] **Step 4: Implement atomic writes and automatic rollback**

For each target, write a sibling `.<basename>.xj-hotfix.tmp`, `fsync`, preserve original mode/owner where permitted, then rename. If any write fails, restore every target already written from the snapshot and exit non-zero.

- [ ] **Step 5: Add secret-safe output**

CLI output may include paths, hashes, counts, booleans, and backup directory. It must never print settings values, MCP environment values, tokens, license state, or the removed `xj-chat` object.

- [ ] **Step 6: Add package scripts**

Add:

```json
{
  "scripts": {
    "xj:containment:test": "node --test ../tools/xj-containment/core.test.cjs",
    "xj:containment:live:pre": "XJ_CONTAINMENT_EXPECT=pre node --test ../tools/xj-containment/live-layout.test.cjs",
    "xj:containment:live:post": "XJ_CONTAINMENT_EXPECT=post node --test ../tools/xj-containment/live-layout.test.cjs",
    "xj:containment:inspect": "node ../tools/xj-containment/cli.cjs inspect",
    "xj:containment:verify": "node ../tools/xj-containment/cli.cjs verify"
  }
}
```

Merge these keys into `hub/package.json`'s existing scripts object; do not replace unrelated scripts. The script values may reference `../tools/xj-containment/...` because npm runs them with `hub/` as the working directory.

- [ ] **Step 7: Run all containment tests**

```bash
npm --prefix hub run xj:containment:test
npm --prefix hub run xj:containment:live:pre
node tools/xj-containment/cli.cjs inspect
```

Expected: tests PASS; inspect reports `ready_to_apply=true`, six known marker types in the expected files, settings not yet contained, and `xj-chat` present. Inspect performs zero writes.

- [ ] **Step 8: Commit the CLI**

```bash
git add tools/xj-containment hub/package.json
git commit -m "feat: add atomic XJ containment CLI"
```

### Task 5: Mark SSoT in progress and run the governed preflight

**Files:**
- Modify: `polaris.json`
- Test: `tests/runtime-governance.test.sh`

- [ ] **Step 1: Add the feature record**

Under requirement `R9` (`运行时端口与进程统一治理`), add a feature named `XJ emergency containment tooling` with `status: in-progress`, implementation paths, the approved design/plan paths, and no claim of successful containment yet.

- [ ] **Step 2: Run transient verification**

```bash
bash tests/runtime-governance.test.sh
~/Polarisor/Agent_core/.cursor/skills/polar-runtime-governance/scripts/runtime-governance-audit.sh --project ~/Polarisor/PolarCopilot
```

Expected: both exit 0; PolarPort and PolarProcess remain healthy. No project service restart is required for the one-shot containment CLI.

- [ ] **Step 3: Commit the in-progress SSoT state**

```bash
git add polaris.json
git commit -m "chore: track XJ containment rollout"
```

### Task 6: Apply the hotfix to the installed Cursor

**Files:**
- Modify through CLI: the five runtime targets listed in the file map.
- Create through CLI: `~/Desktop/XJ/hotfix-backup-<timestamp>/`

- [ ] **Step 1: Run a fresh pre-apply test**

```bash
cd ~/Polarisor/PolarCopilot
npm --prefix hub run xj:containment:test
npm --prefix hub run xj:containment:live:pre
node tools/xj-containment/cli.cjs inspect
```

Expected: PASS and `ready_to_apply=true`.

- [ ] **Step 2: Apply once**

```bash
node tools/xj-containment/cli.cjs apply
```

Expected: exit 0; output includes the absolute backup directory and post-write hashes, but no secret values.

- [ ] **Step 3: Verify disk state before restarting Cursor**

```bash
node tools/xj-containment/cli.cjs verify --backup ~/Desktop/XJ/hotfix-backup-<timestamp>
npm --prefix hub run xj:containment:live:post
```

Expected:

- settings containment values are false;
- `xj-chat` absent and all other MCP keys preserved;
- all six injection markers absent;
- three restored Cursor resources equal their selected clean backups;
- every pre-existing XJ chat-data path still exists; mutable session/log bytes may advance because the old process has not been shut down yet.

If any check fails, run `rollback` using the emitted backup path and do not restart Cursor.

### Task 7: Fully restart Cursor and verify the newly loaded state

**Files:**
- Read only after restart: Cursor logs, processes, configs, and app resources.

- [ ] **Step 1: Gracefully quit Cursor**

Use Cursor's own application quit event:

```bash
osascript -e 'tell application "Cursor" to quit'
```

Poll for at most 30 seconds. If Cursor presents a save dialog or remains running, stop and ask the user; do not use `kill`, `pkill`, or `killall`.

- [ ] **Step 2: Reopen Cursor**

```bash
open -a Cursor
```

Wait for a new Cursor log directory and extension activation completion. Do not start any project service.

- [ ] **Step 3: Verify process/config state**

Run:

```bash
node ~/Polarisor/PolarCopilot/tools/xj-containment/cli.cjs verify --backup ~/Desktop/XJ/hotfix-backup-<timestamp>
pgrep -fal 'xj-mcp-server.cjs' || true
codesign --verify --deep --strict --verbose=2 /Applications/Cursor.app
```

Expected:

- containment verify passes;
- no `xj-mcp-server.cjs` process exists;
- `codesign` may still fail only for retained cursor-cost backup/product resources; restored core JS must not be reported modified.

- [ ] **Step 4: Verify XJ online survival and injection silence**

Inspect the new XJ log without printing credentials. Expected:

- extension activation completes;
- normal XJ network/security-channel initialization can occur;
- no new successful rule load;
- no new `McpStable mcp.配置.install.begin` while `mcpStable.enabled=false`;
- Cursor MCP cache/list has no `xj-chat` tools.

Open a new Cursor chat for future work. Do not resume the previously polluted XJ-launched chat.

### Task 8: Record verified evidence and finish the containment phase

**Files:**
- Modify: `polaris.json`
- Create: `~/Desktop/XJ/XJ热修复验收报告.md`

- [ ] **Step 1: Write a secret-free acceptance report**

Include backup path, before/after hashes, removed marker counts, settings booleans, MCP key-count delta, XJ chat-data path-preservation result, restart timestamps, process result, XJ online result, and exact remaining `codesign` failures. Do not include settings/MCP JSON bodies or credential values.

- [ ] **Step 2: Update SSoT to tested/done only with evidence**

Set the feature to `tested` after static and restart checks pass. Set it to `done` only after the acceptance report exists and the final runtime audit passes.

- [ ] **Step 3: Run final verification**

```bash
cd ~/Polarisor/PolarCopilot
npm --prefix hub run xj:containment:test
npm --prefix hub run xj:containment:live:post
bash tests/runtime-governance.test.sh
~/Polarisor/Agent_core/.cursor/skills/polar-runtime-governance/scripts/runtime-governance-audit.sh --project ~/Polarisor/PolarCopilot
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit evidence-backed completion**

```bash
git add polaris.json
git commit -m "chore: record verified XJ containment"
```

Do not commit `~/Desktop/XJ` backups or reports to Git.
