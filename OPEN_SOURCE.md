# Open Source Edition

This repository is a **standalone** distribution of PolarCopilot. It includes only:

- **Agent Control** — Web UI + MCP (`check_hub`, `send_prompt`, `patch_agent`)
- **YOLO** — alignment document workflow in the Hub UI

It does **not** ship Polarisor-ecosystem integrations (SSoT diff, Prolusion, Pilot projects, task orchestration, Clock, etc.).

## Before publishing

1. Run `npm run setup` on a clean machine (Node ≥ 22).
2. Confirm no local secrets: `.cursor/mcp.json`, `hub/.data/*.sqlite`, API keys in env.
3. Do **not** commit `node_modules/` — only lockfiles and source.
4. Screenshots live in `docs/images/`; README uses relative paths.

## Privacy

- Hub stores runtime data under `hub/.data/` (gitignored).
- `scripts/setup-mcp.sh` writes machine-local paths into `.cursor/mcp.json` (gitignored).
- No production credentials belong in this tree.

## Skills

Bundled Cursor skills use the **`pc-os-*`** prefix to avoid clashing with other `pc-*` skill packs.
