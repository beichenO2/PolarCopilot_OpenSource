---
name: pc-os-start
description: >-
  按仓库 README.md 完成 PolarCopilot 开源版首次部署。
  触发："pc-os-start"、"/pc-os-start"、"按照 README 完成部署"、"按 README 装好"。
---

# PC-OS-Start

**SSOT = `README.md`。** 人类步骤见 README **「给人看的操作清单」**；你执行 README **「给 Agent 的执行清单」** A1～A8，不要自编流程。

## 必须遵守

- **A4**：停下来，提醒用户亲手打开 Cursor **Settings → MCP → hub-agent-1 → Reload**；等用户确认后再继续。
- **A7**：提醒用户打开浏览器、`/pc-os-solo-web`，并在网页点选项。
- 终端：A2 用 `npm run install:all` + `npm run build:web`（或 `npm run setup`）；A3 用 `bash scripts/setup-mcp.sh`。
- A5～A6：`start-hub.sh` + `curl` health；失败查 `/tmp/pc-os-hub.log`。
- A8 可选：`bash scripts/e2e-smoke.sh` 验收。
- 收尾：让用户阅读 README **「完整上手指南」**（含截图与操作逻辑）。

`REPO` = 含 `hub/`、`web/`、`mcp-server/`、`README.md` 的目录。
