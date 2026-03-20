#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="$REPO_DIR/.pi/agent/keybindings.json"
DST="$HOME/.pi/agent/keybindings.json"

if [[ ! -f "$SRC" ]]; then
  echo "Source keybindings not found: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"
ln -sf "$SRC" "$DST"

echo "Linked $DST -> $SRC"
echo "In an active pi session, run: /reload"
