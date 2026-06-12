#!/usr/bin/env bash
set -euo pipefail

# PolarCopilot Skill 同步脚本
# 将 PolarCopilot/.cursor/skills/pc-* 同步到 ~/.codex/skills/ 和 ~/.cursor/skills/
# 同时清理旧的 gsd2-* 死链接

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PC_SRC="${PC_SRC:-$(dirname "$SCRIPT_DIR")}"
SKILLS_DIR="${PC_SRC}/.cursor/skills"

CODEX_TARGET="$HOME/.codex/skills"
CURSOR_TARGET="$HOME/.cursor/skills"

echo "=== PolarCopilot Skill Sync ==="
echo "Source: $SKILLS_DIR"
echo ""

# Phase 1: Clean broken gsd2-* symlinks
echo "--- Phase 1: Cleaning broken gsd2-* symlinks ---"
for target_dir in "$CODEX_TARGET" "$CURSOR_TARGET"; do
  if [ -d "$target_dir" ]; then
    for link in "$target_dir"/gsd2-*; do
      if [ -L "$link" ] && [ ! -e "$link" ]; then
        echo "  Removing broken: $(basename "$link") → $(readlink "$link")"
        rm -f "$link"
      fi
    done
  fi
done

# Phase 2: Sync pc-* skills
echo ""
echo "--- Phase 2: Syncing pc-* skills ---"

mkdir -p "$CODEX_TARGET" "$CURSOR_TARGET"

for skill_dir in "$SKILLS_DIR"/pc*; do
  if [ -d "$skill_dir" ] && [ -f "$skill_dir/SKILL.md" ]; then
    skill_name="$(basename "$skill_dir")"

    # Symlink to ~/.codex/skills/
    if [ -L "$CODEX_TARGET/$skill_name" ]; then
      rm -f "$CODEX_TARGET/$skill_name"
    fi
    ln -sf "$skill_dir" "$CODEX_TARGET/$skill_name"
    echo "  $CODEX_TARGET/$skill_name → $skill_dir"

    # Symlink to ~/.cursor/skills/
    if [ -L "$CURSOR_TARGET/$skill_name" ]; then
      rm -f "$CURSOR_TARGET/$skill_name"
    fi
    ln -sf "$skill_dir" "$CURSOR_TARGET/$skill_name"
    echo "  $CURSOR_TARGET/$skill_name → $skill_dir"
  fi
done

echo ""
echo "--- Phase 3: Summary ---"
echo "pc-* skills in ~/.codex/skills/:"
ls -la "$CODEX_TARGET"/pc* 2>/dev/null | while read line; do echo "  $line"; done
echo ""
echo "pc-* skills in ~/.cursor/skills/:"
ls -la "$CURSOR_TARGET"/pc* 2>/dev/null | while read line; do echo "  $line"; done
echo ""
echo "=== Sync complete ==="
