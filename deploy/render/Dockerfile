# ChronoSight on Render: web app + gateway behind Caddy in one container (DESIGN §5, DL-23).
#
# One origin serves the pages and the API, so the SameSite=Strict session cookie reaches the gateway
# (an *.onrender.com page and a separate *.onrender.com API would be cross-site). Caddy listens on
# $PORT and sends the gateway's paths to 127.0.0.1:8080 and everything else to Next on 127.0.0.1:3000.
#
# This image does NOT run the twin, the media worker or the patch sandbox: Render offers no Docker
# socket for synthesis, and live runs wait for the custom domain (TR-2). The service boots with
# LIVE_RUNS_ENABLED=false and no model key. See deploy/render/README.md.
#
# Build from the repo root:  docker build -f deploy/render/Dockerfile -t chronosight-render .

FROM caddy:2.10-alpine AS caddy

FROM node:24-bookworm-slim
WORKDIR /app

# Dependencies first so the layer caches until a manifest changes.
COPY package.json package-lock.json ./
COPY packages/run-model/package.json packages/run-model/
COPY services/gateway/package.json services/gateway/
COPY services/sandbox-launcher/package.json services/sandbox-launcher/
COPY services/media-worker/package.json services/media-worker/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY . .
# The glasses bundle, then the Next production build. NEXT_PUBLIC_* stay empty on purpose: the browser
# then calls its own origin, which Caddy splits (TH-7: no key and no other origin reaches the page).
RUN npm run build -w apps/web

COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
# The official binary carries a file capability (cap_net_bind_service); a non-root user in Render's container
# cannot exec it ("Operation not permitted"). Caddy listens on $PORT (>1024), so rewrite it as a plain file.
RUN cat /usr/local/bin/caddy > /tmp/caddy && rm /usr/local/bin/caddy && install -m 0755 /tmp/caddy /usr/local/bin/caddy && rm /tmp/caddy \
 && chmod +x deploy/render/start.sh && mkdir -p /app/data /app/replays && chown -R node:node /app

ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    DATA_DIR=/app/data \
    XDG_DATA_HOME=/tmp/caddy-data \
    XDG_CONFIG_HOME=/tmp/caddy-config
USER node
EXPOSE 10000
CMD ["deploy/render/start.sh"]
