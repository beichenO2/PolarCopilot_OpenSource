# CRITERIA · AFK Budget Philosophy（2026-07-31）

- [x] C1: PolarBudget `GET /api/budget` 含 `pressure_level` ∈ {plenty,tight,critical}
  - **证据**：`PolarBudget/src/pressure.ts` + `tests/unit/pressure.test.ts`；`npm test` **32/32 PASS**
  - **Live `:11060`**：`NOT RUN`（本轮禁止重启权威服务；旧进程无该字段，`curl` 见 `pressure_level=None` / `/recommendations/pause` → 404）
- [x] C2: PolarBudget `GET /api/recommendations/pause` 返回 ranked candidates（不含 interactive）
  - **证据**：同 C1 单测 + `server.ts` 路由；live 待用户自行 reload PolarBudget 后验证
- [x] C3: PolarBudget 单测全绿（本轮新增用例覆盖 C1/C2）— `npm test` 32/32
- [x] C4: PolarCopilot spawn-queue 在 critical 时拒绝/延迟新 spawn（可测）— `budgetGate` + `hub/tests/rr` 含 denial 用例
- [x] C5: PolarCopilot runner 将 `desiredSubagents` 钳到 `recommended_jobs` — `clampDesiredSubagents` in runner tick
- [x] C6: budget-shedder 在 critical 时可 stop pausable 服务并落盘 resume 队列；plenty 时 start 恢复 — `budget-shedder.test.ts`
- [x] C7: 权威服务 ID（polar-port/process/budget、polarcop-hub）永不在 pause 名单 — `AUTHORITY_SERVICE_IDS` / `NEVER_PAUSE_REF_PREFIXES`
- [x] C8: `hub/tests/rr` 相关用例全绿；本轮**未**重启权威服务 — **141/141 PASS**（2026-07-31T00:15+08）
- [x] C9: skills `polar-budget.md` + `workflow-process.md` 写明暂停/恢复哲学与 API
