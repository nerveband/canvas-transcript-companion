#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT_DIR/extension/manifest.json','utf8')).version)")"
OUT="$ROOT_DIR/canvas-transcript-companion-v$VERSION.zip"

rm -f "$OUT"
(
  cd "$ROOT_DIR/extension"
  zip -r "$OUT" . -x '*.DS_Store'
)

echo "$OUT"
