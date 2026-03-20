#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC_KEYBINDINGS="$REPO_DIR/.pi/agent/keybindings.json"
DST_KEYBINDINGS="$HOME/.pi/agent/keybindings.json"
SRC_EXTENSIONS="$REPO_DIR/.pi/agent/extensions"
DST_EXTENSIONS="$HOME/.pi/agent/extensions"

if [[ ! -f "$SRC_KEYBINDINGS" ]]; then
  echo "Source keybindings not found: $SRC_KEYBINDINGS" >&2
  exit 1
fi

if [[ ! -d "$SRC_EXTENSIONS" ]]; then
  echo "Source extensions dir not found: $SRC_EXTENSIONS" >&2
  exit 1
fi

mkdir -p "$HOME/.pi/agent"

if [[ -e "$DST_KEYBINDINGS" && ! -L "$DST_KEYBINDINGS" ]]; then
  echo "Refusing to replace non-symlink file: $DST_KEYBINDINGS" >&2
  exit 1
fi

if [[ -e "$DST_EXTENSIONS" && ! -L "$DST_EXTENSIONS" ]]; then
  echo "Refusing to replace non-symlink dir: $DST_EXTENSIONS" >&2
  exit 1
fi

ln -sfn "$SRC_KEYBINDINGS" "$DST_KEYBINDINGS"
ln -sfnT "$SRC_EXTENSIONS" "$DST_EXTENSIONS"

echo "Linked $DST_KEYBINDINGS -> $SRC_KEYBINDINGS"
echo "Linked $DST_EXTENSIONS -> $SRC_EXTENSIONS"
echo "In an active pi session, run: /reload"
