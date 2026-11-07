#!/usr/bin/env bash
# Screenshot the game in headless Chromium (used to check rendering).
#   tools/shoot.sh OUT.png 'demo=1&L=4&script=ff' [WIDTH HEIGHT]
# Starts tools/serve.mjs on a spare port if nothing is listening on it.
set -euo pipefail
out="$1"; query="${2:-}"; w="${3:-1400}"; h="${4:-900}"
port="${SHOOT_PORT:-8139}"
here="$(cd "$(dirname "$0")/.." && pwd)"
if ! curl -s "http://127.0.0.1:$port/" >/dev/null; then
  node "$here/tools/serve.mjs" "$port" >/dev/null 2>&1 &
  srv=$!
  trap 'kill $srv 2>/dev/null' EXIT
  for _ in $(seq 50); do curl -s "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.1; done
fi
browser="$(command -v chromium || command -v google-chrome-stable || command -v google-chrome)"
"$browser" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$(mktemp -d)" --window-size="$w,$h" --virtual-time-budget=6000 \
  --screenshot="$out" "http://127.0.0.1:$port/?$query" 2>/dev/null
echo "$out"
