#!/bin/bash
# sync-skills.sh — Skills 单向同步（SSoT → 消费方加载点）
#
# 使用方式：
#   bash PolarCopilot/scripts/sync-skills.sh
#   或 cd PolarCopilot/hub && npm run sync-skills
#
# SSoT 规则：
#   改 Skill = 改 Git 仓库内的原文件 → commit+push → 跑本脚本
#   SSoT: PolarCopilot/.cursor/skills/  （PC Agent 模式）
#         Agent_core/principles/         （共享约束）
#   派生: ~/.codex/skills/ (symlink)、~/.cursor/skills/ (symlink)、PolarUI/skills/ (备份复制)
#
# 清理说明：
#   AFK：afk（路由+共享库）+ afk-start + afk-solo + afk-go。
#   脚本移除 nightshift 等污染名；afk-start 是合法 skill，勿删。

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# This file lives at PolarCopilot/scripts/sync-skills.sh
PC_REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
POLARISOR_ROOT="${POLARISOR_ROOT:-$(cd "$PC_REPO_ROOT/.." && pwd)}"
CODEX_SKILLS="$HOME/.codex/skills"
CURSOR_SKILLS="$HOME/.cursor/skills"
PC_SKILLS="$PC_REPO_ROOT/.cursor/skills"
AGENT_CORE_PRINCIPLES="$POLARISOR_ROOT/Agent_core/principles"

echo "=== Skills SSoT 同步 ==="
echo "SSoT 源: $PC_SKILLS"
echo "同步目标: $CODEX_SKILLS, $CURSOR_SKILLS"
echo ""

# ──────────────────────────────────────────────────
# 1. 确保 ~/.codex/skills 中的 symlink 与 SSoT 对齐
# ──────────────────────────────────────────────────

mkdir -p "$CODEX_SKILLS"

SKILL_NAMES="pc pc-principles pc-solo-web pc-solo-qa pc-yolo-confirm pc-yolo-execute pc-project-scan rr-orchestrator afk afk-start afk-solo afk-go"
# 消费方若残留这些名字，删除（symlink 或目录），防止污染 AFK 入口
AFK_POLLUTION_NAMES="afk-nightshift afk-night-shift cis-afk-nightshift"
skill_target() {
  case "$1" in
    pc-principles) echo "$AGENT_CORE_PRINCIPLES" ;;
    *)             echo "$PC_SKILLS/$1" ;;
  esac
}

link_skill() {
  local dest_root="$1"
  local skill_name="$2"
  local target="$3"
  local link="$dest_root/$skill_name"

  mkdir -p "$dest_root"

  if [ -L "$link" ]; then
    local current_target
    current_target=$(readlink "$link")
    if [ "$current_target" = "$target" ]; then
      return 1
    fi
    rm "$link"
  elif [ -e "$link" ]; then
    rm -rf "$link"
  fi

  ln -s "$target" "$link"
  echo "  LINK: $dest_root/$skill_name → $target"
  return 0
}

synced=0
for skill_name in $SKILL_NAMES; do
  target=$(skill_target "$skill_name")

  if [ ! -e "$target" ]; then
    echo "  WARN: SSoT 不存在 $target，跳过"
    continue
  fi

  for dest_root in "$CODEX_SKILLS" "$CURSOR_SKILLS"; do
    if link_skill "$dest_root" "$skill_name" "$target"; then
      ((synced++)) || true
    fi
  done
done

# pc-main 是独立实体（不在 PolarCopilot 中），保持不动
if [ -d "$CODEX_SKILLS/pc-main" ] && [ ! -L "$CODEX_SKILLS/pc-main" ]; then
  echo "  KEEP: pc-main (独立实体)"
fi

# 移除 AFK 污染入口（合法：afk / afk-start / afk-solo / afk-go）
pollution_removed=0
for dest_root in "$CODEX_SKILLS" "$CURSOR_SKILLS"; do
  [ -d "$dest_root" ] || continue
  for pollution in $AFK_POLLUTION_NAMES; do
    victim="$dest_root/$pollution"
    if [ -e "$victim" ] || [ -L "$victim" ]; then
      echo "  REMOVE: $victim（AFK 入口污染）"
      rm -rf "$victim"
      ((pollution_removed++)) || true
    fi
  done
done

# ──────────────────────────────────────────────────
# 2. 清理断链 symlink
# ──────────────────────────────────────────────────

broken=0
for skills_root in "$CODEX_SKILLS" "$CURSOR_SKILLS"; do
  [ -d "$skills_root" ] || continue
  for link in "$skills_root"/*; do
    if [ -L "$link" ] && [ ! -e "$link" ]; then
      echo "  CLEAN: 断链 $(basename "$link") → $(readlink "$link")"
      rm "$link"
      ((broken++)) || true
    fi
  done
done

# ──────────────────────────────────────────────────
# 3. PolarUI skills/ 备份同步（.cursor/skills → skills/）
# ──────────────────────────────────────────────────

POLARUI_SSOT="$POLARISOR_ROOT/PolarUI/.cursor/skills"
POLARUI_BACKUP="$POLARISOR_ROOT/PolarUI/skills"

if [ -d "$POLARUI_SSOT" ] && [ -d "$POLARUI_BACKUP" ]; then
  ui_synced=0
  for skill_dir in "$POLARUI_SSOT"/*/; do
    skill_name=$(basename "$skill_dir")
    if [ -f "$skill_dir/SKILL.md" ]; then
      mkdir -p "$POLARUI_BACKUP/$skill_name"
      if ! diff -q "$skill_dir/SKILL.md" "$POLARUI_BACKUP/$skill_name/SKILL.md" >/dev/null 2>&1; then
        cp "$skill_dir/SKILL.md" "$POLARUI_BACKUP/$skill_name/SKILL.md"
        echo "  UI-SYNC: $skill_name"
        ((ui_synced++))
      fi
    fi
  done
  [ $ui_synced -eq 0 ] && echo "  PolarUI 备份已同步，无变化"
fi

echo ""
echo "=== 完成 ==="
echo "  Symlinks 更新: $synced"
echo "  AFK 污染移除: $pollution_removed"
echo "  断链清理: $broken"
