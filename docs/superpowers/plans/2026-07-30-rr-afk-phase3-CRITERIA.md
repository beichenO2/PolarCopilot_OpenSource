# Phase-3 冻结验收判据（CRITERIA · 不可自行放软）

冻结时间：2026-07-30。改判据需用户显式指令。

依据：夜挂机 `completion-criteria`（须含 E2E）· 发版 `mock-smoke`（健康→关键路径）· `quality-gates`（本轮新鲜证据）。

## 布尔判据

| ID | 判据 | 可跑检查 | 层 |
|----|------|----------|----|
| C1 | Hub 进程健康 | `curl -fsS http://127.0.0.1:8040/api/health` → JSON status ok | E2E/冒烟 |
| C2 | AFK status API 契约可读 | `GET /api/ui/rr/afk/status` 含 `active`/`summaries`；HTTP 200 | E2E |
| C3 | 非法 mode 被拒 | `POST /api/ui/rr/afk/one-click` body.`mode=bogus` → HTTP 400 且 body 含 `invalid_afk_mode` | E2E |
| C4 | go 模式副作用（进程内） | L1 vitest：mode=go → summary.mode=go 且 **任务级** `allow_new_subagents=false`（Phase-4 起不再改全局 panel）且 inject 含 `Mode=go` 与禁止 `dispatch_subagent_task` | E2E |
| C5 | solo/start 不误关 Subagent（进程内） | L1 vitest：mode=solo 与 mode=start 不强制 `allowNewSubagents=false` | 测试 |
| C6 | 无主会话负向不 5xx | `POST one-click` `{spawnIfNeeded:false,mode:solo}` → 4xx 业务错误（如 `no_master_session`），非 5xx | E2E |
| C7 | UI 制品含三模式文案 | 对真 Hub `GET /pc/rr`（或打包 JS）响应含 `协作 start`、`自治 solo`、`Go 单主` | E2E/用户可见 |
| C8 | rr 单测全绿（含 L1） | `cd hub && npx vitest run tests/rr` exit 0 | 测试 |
| C9 | 冒烟脚本诚实失败 | `bash hub/scripts/smoke-afk-modes.sh`：失败必须非 0；禁止「打印 ❌ 却 exit 0」 | 冒烟 |
| C10 | web 类型干净 | `cd web && npx tsc --noEmit` exit 0 | 静态 |

## 覆盖率闸门（「全部 mode」）

活分母命令：

```bash
printf '%s\n' start solo go | wc -l   # 期望 3
```

分子：L1 中对 `start`/`solo`/`go` 各有至少 1 条断言通过（C4+C5 合计覆盖 3 个 mode）。分子==3 才允许宣布「三模式 E2E 覆盖完成」。

## 完成条件

- C1–C10 全部本轮新鲜 PASS（不得用上轮日志）
- 覆盖率分子==3
- B 交叉审查无未修 Critical/Important
- 才可写 Phase-3 DONE

任一 E2E 判据 `NOT RUN` → 只能部分完成 / PAUSE，不得 DONE。
