#!/bin/bash
# Build PolarCopilot Web and make it available to Hub
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Building PolarCopilot Web ==="
cd "$WEB_DIR"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install
fi

# Build
echo "Building..."
npm run build

echo "=== Build complete ==="
echo "Output: $WEB_DIR/dist/"
echo ""
echo "Hub will serve the SPA at /pc/ when restarted."
echo "Dev server: HUB_PORT=\${HUB_PORT} npm run dev (port 5180)"
