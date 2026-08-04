# AFK vNext · 需要你亲自做的事（已大幅缩短）

自动化 + 浏览器验收本轮已跑绿。只剩「真 IDE 里 Stop 一下看手感」。

## A. 可选但建议：真 IDE 双 tab Stop 手感（约 3 分钟）

| # | 哪里 | 做什么 | 通过判据 |
|---|------|--------|----------|
| A1 | Cursor **新** Agent 对话 1 | 粘贴下方 Prompt A，等 Agent bind 完 | `gate-check` → `ok:false` + `task_id` |
| A2 | **另一个**新对话 | 粘贴 Prompt B | 另一个 `task_id` |
| A3 | 对话 1 | 说一句「先到这里」后 **Stop** | 仅对话 1 出现 `[AFK_CONTINUE]`，含 A 的 task_id |
| A4 | 对话 2 | 同样 Stop | 仅对话 2 续跑 B |

### Prompt A（整段粘贴）

```text
$afk-solo
用 hub/scripts/pc-afk.sh（或 pc）执行：
afk ide-bind --conversation-id <本对话 conversation_id> --project ~/Polarisor/PolarCopilot --goal "ide-smoke-A"
然后 afk gate-check --conversation-id <同上> --cwd ~/Polarisor/PolarCopilot
把 JSON 贴出来。不要宣称 DONE。
```

### Prompt B

同 A，goal 改为 `ide-smoke-B`。

> conversation_id：若环境无 `$CURSOR_CONVERSATION_ID`，先随便发一句触发 stop，从 hook/`followup_message` 里的 `conversation=` 抄。

## B. Web — Agent 已代做

| 项 | 结果 |
|----|------|
| URL（web-dev） | `http://127.0.0.1:5180/afk`（**不是** `/pc/afk`；生产 build 才是 `/pc/afk`） |
| web-smoke-1/2 | QUEUED 可见；主视图无 sessionId |
| Completion gate | BLOCKED：`wrong_phase` + `required_criteria_unmet` |
| Nav | 已加 **AFK** 链接 |

## C. 不做

- MCP 物理移除（已取消）
- 未授权不删 `ACTIVE`/`PAUSE`/`DONE` 旗标文件

## 证据

- `docs/superpowers/evidence/2026-07-31-afk-vnext-e2e-smoke.json` — 15/15
- `docs/superpowers/evidence/2026-07-31-afk-vnext-full-pass.json` — 本轮综合
