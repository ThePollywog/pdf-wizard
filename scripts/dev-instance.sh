#!/usr/bin/env bash
# Start an isolated Vite dev server so several can run side by side.
#   scripts/dev-instance.sh <name> <webPort>
# Log: /tmp/pdfwizard-<name>-web.log   Stop: scripts/dev-instance.sh stop <name>
# Each port is its own browser origin, so each instance also has its own file library.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" = "stop" ]; then
  f=/tmp/pdfwizard-$2-web.pid
  [ -f "$f" ] && { pkill -P "$(cat "$f")" 2>/dev/null || true; kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; }
  exit 0
fi
name=${1:?name}; web=${2:?webPort}
PORT=$web VITE_CACHE_DIR="node_modules/.vite-$name" nohup npx vite --port "$web" --strictPort > "/tmp/pdfwizard-$name-web.log" 2>&1 &
echo $! > "/tmp/pdfwizard-$name-web.pid"
for i in $(seq 1 60); do
  if curl -sf "http://localhost:$web/" >/dev/null 2>&1; then echo "web: http://localhost:$web"; exit 0; fi
  sleep 1
done
echo "timed out waiting for vite; see /tmp/pdfwizard-$name-web.log" >&2; exit 1
