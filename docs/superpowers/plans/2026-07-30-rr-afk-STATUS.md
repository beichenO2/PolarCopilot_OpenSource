# Rr AFK · 总进度与缺口（2026-07-31）

> 权威状态板。Canvas：工作区 `canvases/rr-afk-status.canvas.tsx`。

## 一句话

**Phase-1～4 DONE**；另加 **Budget 哲学**（pressure + pause 推荐 + spawn gate + shedder），本轮**未重启**权威服务。  
Live `:11060` 仍跑旧二进制 → `pressure_level` / pause API 待用户自行 reload PolarBudget 后生效。

## 阶段总览

| 阶段 | 状态 |
|------|------|
| Phase-1 SSoT / CLI / 删 codex-afk | **DONE** · 在 `15435d6` |
| Phase-2 三模式 + A→B | **DONE** |
| Phase-3 L1/L2 E2E C1–C10 | **DONE** |
| Phase-4 硬化 + 合入 + 真机短跑 | **DONE**（见 phase4-CRITERIA） |
| Budget 哲学（pause/resume） | **DONE（代码+单测）** · live API `NOT RUN` 待 reload |

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

## Budget 哲学（2026-07-31）

| ID | 结果 |
|----|------|
| C1–C3 PolarBudget | PASS 单测 32/32；live `NOT RUN`（禁重启） |
| C4–C7 Hub gate/shedder | PASS · vitest `tests/rr` **141/141** |
| C8–C9 skills + 未重启权威 | PASS · `verify-skills`；证据见下 |

证据：`docs/superpowers/evidence/2026-07-31-afk-budget-philosophy.md`  
计划 / 判据：`…/2026-07-31-afk-budget-philosophy.md` · `…/2026-07-31-afk-budget-CRITERIA.md`

哲学摘要：先钳并发 → critical 再 Process **stop** pausable → plenty 再 **start** 恢复；权威永不 pause。

## Solo 无限进化（纪律）

- **子计划 ≠ 终局**：Budget 哲学等单元 PASS 后必须回到 `afk/current` 终极 CRITERIA，禁止交付收工。
- skills：`afk-solo` / `iteration-loop` / `workflow-process` 已写死「无限进化到终极 CRITERIA」。
- 本轮终局任务：`polaride-desktop-product-v1` → **DONE** · `SHIPPABLE_LOCAL_MAC_UNSIGNED`（`~/.rr-cursor/afk/DONE`；ACTIVE 已清）。

## 仍可选 / 非阻塞

| 项 | 说明 |
|----|------|
| reload PolarBudget | 经 PolarProcess 重启一次以加载 pressure/pause API（用户择时） |
| Developer ID 签名 / Windows / 自动更新 | 新里程碑，未武装 ACTIVE |
| 推远程 / PR | 本轮改动未要求则不 push |
| HTTP list_subagents go 门闩 | MCP 已拦；HTTP GET 子列表未拦（Minor） |

## 相关路径

- Phase-4 计划 / 判据：`…/phase4-harden.md` · `…/phase4-CRITERIA.md`
- Budget：`hub/src/rr/afk/budget-shedder.ts` · `PolarBudget/src/pressure.ts`
- 硬拒：`hub/src/rr/afk/dispatch-guard.ts`
- 短跑：`scripts/smoke-afk-short-run.sh`
- skills：`polar-budget.md` · `workflow-process.md`
