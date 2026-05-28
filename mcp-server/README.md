# hub-mcp-server

MCP bridge between **Cursor** and **PolarCopilot Hub**.

## Tools

| Tool | Purpose |
|------|---------|
| `setup` | Discover Hub, register agent, first prompt |
| `check_hub` | Block until user answers (SSE or poll) |
| `send_prompt` | Send prompt with **options** (required) |
| `patch_agent` | Update display name on Hub |
| `hub_status` | Connection debug |

## Configure (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "hub-agent-1": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/index.mjs"],
      "env": {
        "HUB_SESSION": "1",
        "HUB_PORT": "8040",
        "PC_PROJECT_DIR": "/absolute/path/to/repo-root"
      }
    }
  }
}
```

## Install

```bash
npm install
```

No global install required.
