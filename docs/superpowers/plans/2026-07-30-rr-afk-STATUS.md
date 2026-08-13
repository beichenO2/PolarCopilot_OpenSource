# Rr AFK · 总进度与缺口（2026-07-30 夜）

> 权威状态板。Canvas：工作区 `canvases/rr-afk-status.canvas.tsx`。

## 一句话

**Phase-1～4 已落地并合入分支**（`15435d6` 基线 + Phase-4 harden 提交）。  
Rr AFK 为唯一 SSoT；三模式接线；E2E/冒烟；Go dispatch **硬拒**；任务级 `allow_new_subagents`；skills 已入库。

## 阶段总览

| 阶段 | 状态 |
|------|------|
| Phase-1 SSoT / CLI / 删 codex-afk | **DONE** · 在 `15435d6` |
| Phase-2 三模式 + A→B | **DONE** |
| Phase-3 L1/L2 E2E C1–C10 | **DONE** |
| Phase-4 硬化 + 合入 + 真机短跑 | **DONE**（见 phase4-CRITERIA） |

## Phase-4 证据摘要

| ID | 结果 |
|----|------|
| P4-C1 | PASS · 基线 `15435d6` |
| P4-C2–C6 | PASS · vitest `tests/rr` **137**（含 dispatch-guard） |
| P4-C7 | PASS · `git ls-files` 含 afk/afk-start/afk-solo/afk-go |
| P4-C8 | PASS · `npm run verify-skills` |
| P4-C9 | PASS · `scripts/smoke-afk-modes.sh` |
| P4-C10 | PASS · `scripts/smoke-afk-short-run.sh`（solo + go） |

## 怎么用

```bash
# UI
open http://127.0.0.1:8040/pc/rr   # 选 start/solo/go → 一键AFK

# CLI
cd hub && npm run pc -- afk start --mode solo

# 冒烟
cd hub && npm run smoke:afk-modes && npm run smoke:afk-short-run
AFK_MODE=go npm run smoke:afk-short-run
```

| mode | 问用户 | Subagent | 要点 |
|------|--------|----------|------|
| start | 可商讨 | 面板+Budget | 协作 |
| solo | never-ask | 允许 | 自治 |
| go | never-ask | **任务级 OFF + dispatch 硬拒** | infinite MCP；**不**改全局 config |

## 真机业务 AFK（已跑）

| 项 | 值 |
|----|----|
| taskId | `live-biz-20260730-233406` |
| session | `rr-mcp-agent-9287f31b-…`（Cursor Agent PolarProcess running→stopped） |
| 产物 | `docs/superpowers/evidence/live-biz-20260730-233406.md`（含 `LIVE_AFK_OK`） |
| 结论 | 真 spawn + inject 消费 + 写文件 + reply UNIT_DONE |

PR：https://github.com/beichenO2/PolarCopilot/pull/4

## 仍可选 / 非阻塞

| 项 | 说明 |
|----|------|
| 推远程 / PR | 分支 `dev/hubweb-prompts-ui` 本地 ahead；未要求则不 push |
| 真 Cursor Agent 长跑业务 | 短跑已证明 inject/status；长跑属运行时使用而非门禁 |
| 其它 pc-* skills 入库 | 已入库 afk* / pc / rr-orchestrator；其余仍 untracked（可选） |
| HTTP list_subagents go 门闩 | MCP 已拦；HTTP GET 子列表未拦（Minor） |

## 相关路径

- Phase-4 计划 / 判据：`…/phase4-harden.md` · `…/phase4-CRITERIA.md`
- 硬拒：`hub/src/rr/afk/dispatch-guard.ts`
- 短跑：`scripts/smoke-afk-short-run.sh`
