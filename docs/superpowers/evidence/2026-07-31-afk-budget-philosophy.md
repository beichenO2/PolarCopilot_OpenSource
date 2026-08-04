# Evidence · AFK × PolarBudget philosophy（2026-07-31）

Mode=solo · **未重启** PolarPort / PolarProcess / PolarBudget / polarcop-hub。

## 命令与结果

| 命令 | 结果 |
|------|------|
| `cd PolarBudget && npm test` | **32/32 PASS** |
| `cd PolarCopilot/hub && npx vitest run tests/rr` | **141/141 PASS**（22 files） |
| `cd hub && npm run verify-skills` | exit 0 |
| `curl :11060/api/budget` → `pressure_level` | `None`（旧进程） |
| `curl :11060/api/recommendations/pause` | **404**（旧进程） |

## 代码落点

| 组件 | 路径 |
|------|------|
| pressure / pause rank | `PolarBudget/src/pressure.ts` |
| pause API | `PolarBudget/src/server.ts` `GET /api/recommendations/pause` |
| spawn gate | `hub/src/rr/spawn-queue.ts` `budgetGate` |
| shedder | `hub/src/rr/afk/budget-shedder.ts` |
| pool clamp | `hub/src/rr/orchestrator/runner.ts` |
| skills | `.cursor/skills/afk/skills/polar-budget.md` · `workflow-process.md` |

## 人工后续（非本轮）

用户自行经 PolarProcess **reload/restart `polar-budget` 一次**后，再 curl 验证 C1/C2 live；本轮按约束不做。
