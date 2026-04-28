#!/usr/bin/env bash
set -euo pipefail

# Proxmox VE API wrapper
# Usage: pve-api.sh <METHOD> <PATH> [key=value ...]
#
# Examples:
#   pve-api.sh GET /nodes
#   pve-api.sh GET /nodes/pve1/qemu
#   pve-api.sh POST /nodes/pve1/qemu/100/status/start
#   pve-api.sh GET /cluster/resources type=vm

BASE_URL="https://proxmox.fishmt.net/api2/json"

if [[ -z "${PROXMOX_TOKEN_ID:-}" || -z "${PROXMOX_TOKEN:-}" ]]; then
  echo "Error: PROXMOX_TOKEN_ID and PROXMOX_TOKEN must be set" >&2
  echo "  PROXMOX_TOKEN_ID = user@realm!tokenid" >&2
  echo "  PROXMOX_TOKEN    = secret UUID" >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: pve-api.sh <METHOD> <PATH> [key=value ...]" >&2
  exit 1
fi

METHOD="${1^^}"
PATH_ARG="$2"
shift 2

# Strip leading slash for consistency
PATH_ARG="${PATH_ARG#/}"

AUTH_HEADER="Authorization: PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN}"

CURL_ARGS=(
  -s -k
  -X "$METHOD"
  -H "$AUTH_HEADER"
  -H "Content-Type: application/json"
)

# Collect key=value pairs
if [[ $# -gt 0 ]]; then
  if [[ "$METHOD" == "GET" || "$METHOD" == "DELETE" ]]; then
    # Append as query parameters
    QUERY=""
    for param in "$@"; do
      if [[ -n "$QUERY" ]]; then
        QUERY="${QUERY}&${param}"
      else
        QUERY="$param"
      fi
    done
    PATH_ARG="${PATH_ARG}?${QUERY}"
  else
    # POST/PUT: build JSON body from key=value pairs
    JSON_BODY="{"
    FIRST=true
    for param in "$@"; do
      key="${param%%=*}"
      value="${param#*=}"
      if [[ "$FIRST" == true ]]; then
        FIRST=false
      else
        JSON_BODY="${JSON_BODY},"
      fi
      # Try to detect numbers and booleans, otherwise quote as string
      if [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" == "true" ]] || [[ "$value" == "false" ]]; then
        JSON_BODY="${JSON_BODY}\"${key}\":${value}"
      else
        JSON_BODY="${JSON_BODY}\"${key}\":\"${value}\""
      fi
    done
    JSON_BODY="${JSON_BODY}}"
    CURL_ARGS+=(-d "$JSON_BODY")
  fi
fi

URL="${BASE_URL}/${PATH_ARG}"

RESPONSE=$(curl "${CURL_ARGS[@]}" "$URL" 2>&1)

if command -v jq &>/dev/null && echo "$RESPONSE" | jq . 2>/dev/null; then
  :
else
  echo "$RESPONSE"
fi
