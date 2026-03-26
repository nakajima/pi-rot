#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/../server" && pwd)"

if ! command -v bun &>/dev/null; then
  echo "bun not found. Install it first: https://bun.sh" >&2
  exit 1
fi

cd "$SERVER_DIR"
bun run src/cli.ts install-server "$@"
