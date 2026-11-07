#!/usr/bin/env bash
# Run dsh-remote-agent on Linux/macOS (foreground).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node 18+ first." >&2
  exit 1
fi
exec node "$DIR/dsh-remote-agent.mjs" "$@"
