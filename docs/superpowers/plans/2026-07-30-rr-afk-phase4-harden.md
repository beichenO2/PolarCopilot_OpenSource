# Rr AFK Phase-4 · 产品硬化 + 合入

> **状态：DONE（2026-07-30）** · 总板 [`2026-07-30-rr-afk-STATUS.md`](./2026-07-30-rr-afk-STATUS.md)  
> 冻结判据：[`2026-07-30-rr-afk-phase4-CRITERIA.md`](./2026-07-30-rr-afk-phase4-CRITERIA.md)

## 已交付

| 单元 | 结果 |
|------|------|
| P4-1 基线合入 | `15435d6 feat(rr-afk): land Rr AFK SSoT…` |
| U0 冻结判据 | phase4-CRITERIA.md |
| U1 Go MCP/HTTP 硬拒 | `dispatch-guard` + mcp-server + router 403 |
| U2 任务级 allow_new | `applyAfkModeConfig` 不再 PATCH 全局；summary 字段 |
| U3 真机短跑 | `scripts/smoke-afk-short-run.sh` solo+go PASS |
| U4 Skills 入库 | `.gitignore` 例外 + `git add` afk* / pc / rr-orchestrator |
| U5 冒烟复跑 | smoke-afk-modes + vitest 137 + verify-skills |

## B 交叉审查

- 首轮 NO-GO：skills 未 staged + skill 仍教全局 PATCH → 已修  
- 代码侧 P4-C2–C6：无 Critical/Important  
- 复审门禁：P4-C7/C8/C9/C10 本轮 PASS 后收口 DONE
