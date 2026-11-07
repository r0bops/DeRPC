#!/usr/bin/env bash
# Operator-side SSH control. The website never receives these credentials.
set -euo pipefail
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo 'Usage: demo-scenario.sh demo-2|demo-3 status|off|corrupt-proof|unavailable [seconds:1-300]' >&2
  exit 1
fi
case "$1" in
  demo-2) destination=root@192.248.176.219 ;;
  demo-3) destination=root@45.76.81.156 ;;
  *) echo 'Only demo-2 and demo-3 support deliberate faults; demo-1 stays healthy.' >&2; exit 1 ;;
esac
case "$2" in
  status|off) [[ $# == 2 ]] || { echo 'status/off take no duration' >&2; exit 1; } ;;
  corrupt-proof|unavailable)
    duration=${3:-60}
    [[ $duration =~ ^[1-9][0-9]{0,2}$ ]] && ((duration <= 300)) || { echo 'Duration must be 1–300 seconds' >&2; exit 1; }
    set -- "$1" "$2" "$duration"
    ;;
  *) echo 'Unknown scenario' >&2; exit 1 ;;
esac
# All interpolated arguments have the strict allowlists above; no user-supplied shell fragments.
exec ssh -o BatchMode=yes -o ConnectTimeout=10 "$destination" "/opt/derpc/demo/control.sh $2${3:+ $3}"
