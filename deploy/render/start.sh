#!/usr/bin/env bash
# Runs the gateway, the Next server and Caddy in one container. If any of them exits, the rest are stopped and
# the container exits non-zero so Render restarts the service. Nothing here prints a secret.
set -euo pipefail
cd /app

PORT="${PORT:-10000}"
export PORT

# Render exposes the public https origin as RENDER_EXTERNAL_URL. The gateway accepts state-changing requests only
# from PUBLIC_ORIGINS (TECHNICAL §7.1), and the page is served from that same origin.
export PUBLIC_ORIGINS="${PUBLIC_ORIGINS:-${RENDER_EXTERNAL_URL:-http://localhost:${PORT}}}"

# Hosted without a model key: live runs are paused (TR-2) and the gateway boots with no upstream.
export LIVE_RUNS_ENABLED="${LIVE_RUNS_ENABLED:-false}"
export MOCK_META="${MOCK_META:-true}"

# A deploy that forgot these still boots; sessions and approvals then do not survive a restart.
rand() { head -c 48 /dev/urandom | base64 | tr -d '\n=+/'; }
export SESSION_SIGNING_KEY="${SESSION_SIGNING_KEY:-$(rand)}"
export APPROVAL_HMAC_KEY="${APPROVAL_HMAC_KEY:-$(rand)}"

mkdir -p "${DATA_DIR:-/app/data}"

pids=()
start() {
  "$@" &
  pids+=("$!")
}
stop_all() {
  kill "${pids[@]}" 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

start env PORT=8080 HOST=127.0.0.1 node services/gateway/src/server.ts
start env PORT=3000 node node_modules/next/dist/bin/next start apps/web -p 3000 -H 127.0.0.1
start caddy run --config deploy/render/Caddyfile --adapter caddyfile

wait -n || true
echo "a process exited; stopping the container" >&2
stop_all
exit 1
