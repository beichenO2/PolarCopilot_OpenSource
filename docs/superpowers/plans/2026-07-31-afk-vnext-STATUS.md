# AFK vNext Implementation Status — 2026-07-31

## Steps

| Step | Status | Evidence |
|------|--------|----------|
| 0 Discovery + ADR | DONE | `afk-vnext-discovery.md`, `afk-vnext-ADR.md` |
| 1 SQLite + invariants | DONE | `hub/src/rr/afk/vnext/*` |
| 2 Completion gate | DONE | hardened bridge; no evidence fan-out |
| 3 IDE adapter + stop hook | DONE | hook + `pc-afk.sh`; cwd-filtered gate-check |
| 4 Web CLI adapter | DONE | PolarProcess ephemeral `cursor-cli-afk-*` |
| 5 UI `/afk` (dev) · `/pc/afk` (build) | DONE | Nav link; Chrome snapshot shows tasks + BLOCKED gate |
| 6 Skills | DONE | afk / start / solo; go retired |
| 7 MCP | **CANCELLED / WONTDO** | 用户明确取消物理移除 |
| 8 E2E | AUTO PASS；真 IDE Stop 手感仍建议点一次 | smoke 15/15 ×2；full-pass JSON |

## Fresh VERIFY (this round)

```text
VERIFY_CMD: node hub/scripts/afk-vnext-e2e-smoke.mjs
EXPECT: pass=15 fail=0
RESULT: PASS (ran twice after hook fix)
```

```text
VERIFY_CMD: Chrome → http://127.0.0.1:5180/afk + click Completion gate on web-smoke-1
EXPECT: AFK Tasks list; gate BLOCKED (wrong_phase + required_criteria_unmet); no sessionId primary
RESULT: PASS (a11y snapshot)
NOTE: web-dev base=/ → use /afk not /pc/afk (build base=/pc/)
```

```text
VERIFY_CMD: stop-hook stdin with hook_event_name=stop; dual conv; cross-cwd=/other
EXPECT: A/B distinct AFK_CONTINUE task_ids; /other → {}
RESULT: PASS after pc-afk.sh + cwd SQL/CLI filter
```

## Fixes this round

- `hub/scripts/pc-afk.sh` — local `pc afk` when `pc` not on PATH
- `hub/scripts/afk-stop-hook.sh` — use wrapper; cwd filter (was leaking cross-cwd on sqlite fallback)
- `web/src/components/Nav.tsx` — add AFK nav link
- Checklist URL corrected to `/afk` for web-dev

## Human remaining

真 Cursor 两个 Agent tab 各 Stop 一次（A3/A4 手感）仍无法由本会话代替点 UI。  
合成 hook + CLI dual chat + 本页 Web 已覆盖逻辑。见 HUMAN-CHECKLIST（已缩短）。

## Critique

- First critic: REDO (stale full-pass URL + missing dual smoke archives)
- Evidence rewritten: `/afk` URL, a11y dump, run1/run2 JSON
- Re-critique: **APPROVE** (MUST_FIX 1–4 closed)
