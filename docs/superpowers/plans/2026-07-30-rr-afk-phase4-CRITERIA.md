# Phase-4 冻结验收判据（CRITERIA · 不可自行放软）

冻结时间：2026-07-30。改判据需用户显式指令。  
总板：`2026-07-30-rr-afk-STATUS.md` · 计划：`2026-07-30-rr-afk-phase4-harden.md`。

## 布尔判据

| ID | 判据 | 可跑检查 |
|----|------|----------|
| P4-C1 | 基线已合入 git | `git log -1 --oneline` 含 `rr-afk` / SSoT 落地提交 |
| P4-C2 | Go MCP dispatch 硬拒 | vitest：会话 `afkTaskId`→`mode=go` 时 `dispatch_subagent_task` 返回 error，含 `afk_mode_go_forbids_dispatch` |
| P4-C3 | Go HTTP dispatch 硬拒 | vitest/router：`POST .../sessions/:id/dispatch` → 4xx，body/错误含同码 |
| P4-C4 | solo/start 仍可 dispatch | 同 harness：mode≠go（或无 afk 绑定）dispatch 成功路径不被误伤 |
| P4-C5 | Go 不踩全局 Subagent 开关 | `oneClickAfk({mode:'go'})` **不** `patchGlobalConfig(allowNewSubagents:false)`；任务 `summary.allow_new_subagents===false`（或等效字段） |
| P4-C6 | 有效 Subagent 策略读任务覆盖 | `effectiveAllowNewSubagents(taskId)`：go→false；solo/start→跟全局（或任务显式覆盖） |
| P4-C7 | Skills 可版本控制 | `git ls-files` 能列出 `afk`/`afk-start`/`afk-solo`/`afk-go` 的 `SKILL.md`（路径在仓库内） |
| P4-C8 | sync-skills 双端一致 | `cd hub && npm run verify-skills` exit 0 |
| P4-C9 | L2 冒烟仍绿 | `npm run smoke:afk-modes` 或 `bash scripts/smoke-afk-modes.sh` PASS |
| P4-C10 | 真机短跑 | 证据：`one-click`（或复用主会话）后 `afk/status` 含 `mode` + 主会话存在；inject 入 inbox 或已被消费（见短跑脚本输出） |

## 完成条件

- P4-C1–C10 本轮新鲜 PASS（C10 允许半自动短跑脚本）
- B 交叉审查无未修 Critical/Important
- 才可写 Phase-4 DONE
