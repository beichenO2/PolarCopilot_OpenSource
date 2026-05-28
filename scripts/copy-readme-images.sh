#!/usr/bin/env bash
# 将 README 截图复制到 web/public，构建后可通过 Hub 访问 /pc/readme/*.png
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/docs/images"
DST="$REPO/web/public/readme"
mkdir -p "$DST"
if [ ! -d "$SRC" ] || [ -z "$(ls -A "$SRC"/*.png 2>/dev/null)" ]; then
  echo "warn: no PNG in $SRC — run: bash scripts/capture-screenshots.sh"
  exit 0
fi
cp -f "$SRC"/*.png "$DST/"
echo "copied $(ls "$DST"/*.png | wc -l | tr -d ' ') screenshots -> web/public/readme/"
