#!/bin/bash
# 零构建插件：lib/index.js 即产物，这里只做语法与产物自检。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
test -f lib/index.js || { echo "build: lib/index.js missing" >&2; exit 1; }
node --check lib/index.js
echo "build: ok (zero-build, lib/index.js)"
