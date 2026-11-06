#!/usr/bin/env bash
# Follow DeRPC's local logs in one terminal: demo call events (written by the Vite dev server while the
# demo page is open) and the tor-js-gateway output. Start the services first with scripts/dev-services.sh.
# Usage: scripts/show-logs.sh [calls|gateway|all]   (default: all)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.dev-logs"
mkdir -p "$DIR"
touch "$DIR/calls.log" "$DIR/gateway.log"
WHAT="${1:-all}"

# One colored line per call event.
format_calls() {
  jq --unbuffered -r '
    def c(code): "\u001b[" + code + "m";
    (.at[11:19]) as $t
    | if .kind == "pool" then
        (if .data.type == "success" then c("32") elif .data.type == "invalid-proof" or .data.type == "exhausted" or .data.type == "stopped" then c("31") elif .data.type == "transient-failure" then c("33") else c("0") end)
        + "\($t) POOL   \(.data.type)" + (if .data.endpoint then " · \(.data.endpoint)" else "" end)
        + (if .data.attempt then " · attempt \(.data.attempt)" else "" end)
        + (if .data.detail then " · \(.data.detail[0:160])" else "" end) + c("0")
      elif .kind == "read" then
        (if (.data.result | test("verified")) then c("32") elif (.data.result | test("refused as expected")) then c("33") else c("31") end)
        + "\($t) READ   \(.data.read[0:60]) → \(.data.result[0:110]) · via \(.data.via) · \(.data.time)" + c("0")
      elif .kind == "status" then
        c("36") + "\($t) STATUS worker=\(.data.transport) · lc=\(.data.lightClient)"
        + (if .data.block then " · block \(.data.block)" else "" end) + " · pin=\(.data.pin)"
        + (if .data.operators != "" then " · \(.data.operators)" else "" end) + c("0")
      elif .kind == "worker" then
        c("90") + "\($t) WORKER [\(.data.level)] \(.data.text[0:200])" + c("0")
      else tostring end'
}

case "$WHAT" in
  calls) tail -n 50 -F "$DIR/calls.log" | format_calls ;;
  gateway) tail -n 50 -F "$DIR/gateway.log" ;;
  all)
    trap 'kill 0' EXIT INT TERM
    tail -n 50 -F "$DIR/gateway.log" | sed -u $'s/^/\e[35mGATEWAY\e[0m /' &
    tail -n 50 -F "$DIR/calls.log" | format_calls
    ;;
  *) echo "usage: $0 [calls|gateway|all]" >&2; exit 1 ;;
esac
