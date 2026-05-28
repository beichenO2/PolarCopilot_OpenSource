#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/.cursor/skills"
for dest in "$HOME/.cursor/skills" "$HOME/.codex/skills"; do
  mkdir -p "$dest"
  # Remove legacy names if a previous sync copied pc-* into global skills
  for legacy in pc-start pc-solo-web pc-yolo-confirm pc-yolo-execute pc-principles; do
    rm -rf "$dest/$legacy"
  done
  for skill in pc-os-start pc-os-solo-web pc-os-yolo-confirm pc-os-yolo-execute pc-os-principles; do
    if [ -d "$SRC/$skill" ]; then
      rm -rf "$dest/$skill"
      cp -R "$SRC/$skill" "$dest/$skill"
      echo "synced $skill -> $dest"
    fi
  done
done
