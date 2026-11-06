#!/usr/bin/env bash
# Start the local side services for DeRPC development:
#   1. our own tor-js-gateway (UDP 12298), unless one is already running
#   2. one Vite dev server on port 5174 (pnpm dev:site), in the foreground:
#      the directory at /, the live demo at /demo/
# Ctrl-C stops the dev server and the gateway this script started.
# Usage: scripts/dev-services.sh [--force]   (--force rebuilds Vite's dependency cache)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATEWAY="${TOR_JS_GATEWAY:-$ROOT/reference/tor-js/target/release/tor-js-gateway}"
LOG_DIR="$ROOT/.dev-logs"
mkdir -p "$LOG_DIR"

# ss and ip are Linux tools; macOS has lsof and ifconfig instead.
# lsof also lists a client socket that is only connected to port 12298 ("local->remote"),
# so compare the local side of each socket name: the gateway is the one bound to the port.
gateway_up() {
  ss -uln 2>/dev/null | grep -q ':12298\b' && return 0
  local names
  names="$(lsof -nP -iUDP:12298 -Fn 2>/dev/null | sed -n '/^n/{s/^n//;s/->.*//;p;}')" || true
  grep -q ':12298$' <<< "$names"
}
local_addresses() {
  ip -o -4 address show 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }' || true
  ifconfig 2>/dev/null | awk '$1 == "inet" { print $2 }' || true
}

started_gateway=""
cleanup() {
  if [ -n "$started_gateway" ]; then
    echo "stopping tor-js-gateway (pid $started_gateway)"
    kill "$started_gateway" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if gateway_up; then
  echo "tor-js-gateway already listening on UDP 12298, reusing it"
else
  if [ ! -x "$GATEWAY" ]; then
    echo "tor-js-gateway not found at $GATEWAY" >&2
    echo "Build it from reference/tor-js (cargo build --release -p tor-js-gateway) or set TOR_JS_GATEWAY." >&2
    exit 1
  fi
  [ -f "$HOME/.config/tor-js-gateway/config.json5" ] || "$GATEWAY" init
  echo "starting tor-js-gateway (log: $LOG_DIR/gateway.log)"
  "$GATEWAY" run >"$LOG_DIR/gateway.log" 2>&1 &
  started_gateway=$!
  for _ in $(seq 1 60); do gateway_up && break; sleep 0.5; done
  gateway_up || { echo "gateway did not start; see $LOG_DIR/gateway.log" >&2; exit 1; }
  echo "tor-js-gateway up (it may need ~30 s to sync the Tor directory on first run)"
fi

# A surviving gateway can leave an old address in its startup log after a network change.
# Only copy an address still assigned to this machine, and preserve an explicit shell setting.
addr="$(sed 's/\x1b\[[0-9;]*m//g' "$LOG_DIR/gateway.log" 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+){3}:12298:[A-Za-z0-9_-]+' | tail -1 || true)"
if [ -n "${VITE_TOR_GATEWAYS:-}" ]; then
  echo "using VITE_TOR_GATEWAYS from the shell; leaving frontend/.env.local unchanged"
elif [ -n "$addr" ]; then
  local_ipv4="$(local_addresses)"
  if grep -Fxq -- "${addr%%:*}" <<< "$local_ipv4"; then
    env_file="$ROOT/frontend/.env.local"
    if ! grep -Fxq "VITE_TOR_GATEWAYS=$addr" "$env_file" 2>/dev/null; then
      touch "$env_file"
      grep -v '^VITE_TOR_GATEWAYS=' "$env_file" > "$env_file.tmp" || true
      echo "VITE_TOR_GATEWAYS=$addr" >> "$env_file.tmp"
      mv "$env_file.tmp" "$env_file"
      echo "set VITE_TOR_GATEWAYS to this gateway: ${addr%%:*}"
    fi
  else
    echo "gateway log address ${addr%%:*} is not confirmed on a current interface; leaving frontend/.env.local unchanged" >&2
    echo "restart the gateway after a network change, or set VITE_TOR_GATEWAYS explicitly" >&2
  fi
fi

if [ -z "${VITE_TOR_GATEWAYS:-}" ] && [ ! -f "$ROOT/frontend/.env.local" ]; then
  echo "note: frontend/.env.local is missing, so the page uses the tor-js demo gateway."
  echo "      Copy frontend/.env.example and set VITE_TOR_GATEWAYS to this gateway's KPS address."
fi

cd "$ROOT"
[ -d node_modules ] || pnpm install
echo "site: http://localhost:5174/   demo: http://localhost:5174/demo/"
if [ "${1:-}" = "--force" ]; then
  pnpm --filter web exec vite --force
else
  pnpm dev:site
fi
