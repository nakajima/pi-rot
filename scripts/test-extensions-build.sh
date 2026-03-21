#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

GLOBAL_NODE_MODULES="${PI_GLOBAL_NODE_MODULES:-$HOME/.cache/.bun/install/global/node_modules}"
PI_CODING_AGENT_TYPES="$GLOBAL_NODE_MODULES/@mariozechner/pi-coding-agent/dist/index.d.ts"
PI_TUI_TYPES="$GLOBAL_NODE_MODULES/@mariozechner/pi-tui/dist/index.d.ts"
TYPEBOX_TYPES="$GLOBAL_NODE_MODULES/@sinclair/typebox/build/cjs/index.d.ts"
NODE_TYPES_ROOT="$GLOBAL_NODE_MODULES/@types"
REPO_ROOT="$(pwd)"

for path in "$PI_CODING_AGENT_TYPES" "$PI_TUI_TYPES" "$TYPEBOX_TYPES" "$NODE_TYPES_ROOT"; do
  if [[ ! -e "$path" ]]; then
    printf 'Missing required type path: %s\n' "$path" >&2
    printf 'Set PI_GLOBAL_NODE_MODULES if your bun global install lives elsewhere.\n' >&2
    exit 1
  fi
done

TMP_CONFIG="$(mktemp)"
cleanup() {
  rm -f "$TMP_CONFIG"
}
trap cleanup EXIT

cat >"$TMP_CONFIG" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"],
    "typeRoots": [
      "$NODE_TYPES_ROOT"
    ],
    "paths": {
      "@mariozechner/pi-coding-agent": [
        "$PI_CODING_AGENT_TYPES"
      ],
      "@mariozechner/pi-tui": [
        "$PI_TUI_TYPES"
      ],
      "@sinclair/typebox": [
        "$TYPEBOX_TYPES"
      ]
    }
  },
  "include": [
    "$REPO_ROOT/.pi/agent/extensions/**/*.ts"
  ]
}
JSON

printf 'Type-checking pi extensions...\n'
bunx tsc -p "$TMP_CONFIG"
printf 'OK: pi extensions type-check successfully.\n'
