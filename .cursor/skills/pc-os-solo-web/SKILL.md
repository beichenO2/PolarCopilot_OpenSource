---
name: pc-os-solo-web
description: >-
  PolarCopilot Open Source Solo Web: MCP + Hub UI. Agent Control and YOLO only.
  Trigger: "/pc-os-solo-web", "pc-os web mode", "opensource hub web".
---

# PC-OS Solo Web

## Rules

1. **No SubAgent / Task tool** — do all work in this chat.
2. After every task: `send_prompt` (with **options**) → **`check_hub`** — do not stop without `check_hub`.
3. User input comes from Hub Web only (no AskQuestion).

## Start

```bash
bash scripts/solo-web-startup.sh 1
```

```
CallMcpTool("hub-agent-1", "setup", {})
```

(Cursor may prefix: `project-<Workspace>-hub-agent-1`.)

Then `check_hub` until the user chooses an option.

## MCP tools

| Tool | Use |
|------|-----|
| setup | Once per session / after Hub restart |
| check_hub | Wait for user's button click |
| send_prompt | Report or ask; **must include options**；多 Agent 时用 **`display_name`** 自命名（会显示在问题卡片上，无左侧 Agent 列表） |
| patch_agent | 也可单独改显示名 |
| hub_status | Debug connection |

## YOLO

Triggers like "YOLO", "full auto", "对齐" → `pc-os-yolo-confirm` → user approves on YOLO page → `pc-os-yolo-execute`.

## Report template (send_prompt)

Markdown summary: goal, changes, verification. Options example:

`["Continue", "New task", "Open YOLO page"]`

Never offer "exit" or "stop forever" — loop back to `check_hub`.
