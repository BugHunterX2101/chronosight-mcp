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
# A PID from a prior container is not meaningful after Render restarts it. This per-container
# value lets the persistent budget ledger distinguish that stale lock from another gateway in
# the current container.
export GATEWAY_INSTANCE_ID="${GATEWAY_INSTANCE_ID:-$(rand)}"

mkdir -p "${DATA_DIR:-/app/data}"

pids=()
start() {
  local name="$1"
  shift
  "$@" &
  pids+=("$!")
  echo "started $name (pid $!)" >&2
}
stop_all() {
  kill "${pids[@]}" 2>/dev/null || true
}
trap 'stop_all; exit 0' TERM INT

wait_for_http() {
  local name="$1"
  local url="$2"
  local pid="$3"
  for _ in $(seq 1 45); do
    if node -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(1000) }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' "$url"; then
      echo "$name is ready" >&2
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before becoming ready" >&2
      return 1
    fi
    sleep 1
  done
  echo "$name did not become ready within 45 seconds" >&2
  return 1
}

# Do not accept traffic until both upstreams answer. This avoids Caddy emitting a misleading 502
# during Node's cold startup and gives the platform an unambiguous readiness signal.
start gateway env PORT=8080 HOST=127.0.0.1 node services/gateway/src/server.ts
wait_for_http gateway http://127.0.0.1:8080/api/healthz "${pids[0]}"
start web env PORT=3000 node node_modules/next/dist/bin/next start apps/web -p 3000 -H 127.0.0.1
wait_for_http web http://127.0.0.1:3000/ "${pids[1]}"
start caddy caddy run --config deploy/render/Caddyfile --adapter caddyfile

wait -n || true
echo "a supervised process exited; stopping the container" >&2
stop_all
exit 1
