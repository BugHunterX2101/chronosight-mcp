# Hand-off

State of ChronoSight as of 2026-11-01, branch `build/wip` (remote `BugHunterX2101/chronosight-mcp`). Read [README.md](README.md) first for architecture, env names and commands; this file is what you need to continue.

## 1. Where things stand

**Verified at hand-off**
- `npx vitest run`: 569 tests, 39 files, pass. `pytest services/twin/tests`: 50 pass. `tsc -p` on gateway, web, media-worker and run-model clean.
- Live Meta Model API smoke check: one PUBLIC S1 diagnosis completed with the configured server-side key, 172.4 s elapsed, observed model cost `$0.0069`, exit code 0. No key or raw credential material was logged or stored.
- Baseten and Modal were not invoked: this codebase currently exposes only their configuration names and documentation, not a provider client or executable partner lane. They remain acceptance-blocked rather than being represented as validated.
- After the check, `.env.local` remained `LIVE_RUNS_ENABLED=false`, `PARTNER_ENDPOINTS_ENABLED=false`, and `MOCK_META=false`; no live run, BYO verification, placebo, HUD acceptance, or real-hardware check was performed.
- Hosted demo: https://chronosight.onrender.com (Render service `srv-dbjmjas9v7es73ai13i0`, team `chronosight-mcp` = `tea-dbjm7dnf3r2c73cgjk10`, branch `deploy/render`, deploy `dep-dbjmkilg1s2s7386ddf0` is live). Probed: `/api/healthz` 200, `/api/scenarios` 200 (`uploads:false`), `/`, `/about`, `/hud`, `/admin` 200, `/replays/index.json` 200, `/replay/run_01M68V2MKCFX6SQ14ZNWPSSWXD` plays in a browser (manifest, events, clip and masks all 200, sha256 check passes, no console errors apart from one CSP `eval` informational issue), `POST /api/sessions` 201 with an `HttpOnly; Secure; SameSite=Strict` cookie, `/admin/health` without a token 401, a POST from a foreign Origin 403. `/api/readyz` returns 503 there by design (no twin or launcher).

**Built**: twin and deterministic S1/S2/S3 scenario packages; gateway (orchestrator, approvals, diagnosis, SAM client, ledger, audit chain, replay recorder, HUD pairing and transports, ASR relay, beacons, admin health and warm); sandbox launcher and egress proxy; media worker; web (home, workbench, replay, report, about, admin, `/hud`, PsdChart, PlaceboButton, GlassesPreview, WebMCP, voice, bring-your-own-clip panel).

**Not done** (in priority order)
1. **Replay publisher** (DESIGN/TECHNICAL CDN publish step): `STORAGE_BUCKET_URL` / `STORAGE_KEY` are not wired. The recorder (`services/gateway/src/replay/record.ts`) writes `replays/<runId>/` locally; the gateway serves it. Nothing uploads to a bucket.
2. **Whole-product sweep and video readiness**: a pass over every route, navigation, error and empty state, mobile widths, performance, and a rehearsed demo script. Not finished.
3. **HUD wording for a BYO run**: `services/gateway/src/hud/project.ts` strips `RunView.reason`, so the glasses cannot say "analysed, no patch". `apps/web/lib/voice/narration.ts` has no ABORTED case (returns null), so the voice agent is silent at the BYO end state.
4. **Live checks that cost money** (all need explicit approval, see section 4): HUD states H4/H5/HE from a real run; a real placebo run; a real BYO run.
5. Audio extraction from uploads (FR-DIA-6), D1 logs, and real browser validation of webcam capture.
6. Diagnosis latency: the spec target is <= 30 s; measured xhigh latency forced a 240 s per-attempt cap. Unmet.
7. `graphify-out/` was refreshed after the bring-your-own-clip commits; run `graphify update .` after code changes.

## 2. Resume locally

```bash
git checkout build/wip && git pull
npm ci && uv sync            # Windows: the repo's venv is .venv; python is .venv/Scripts/python.exe
cp .env.example .env.local   # fill values
cd services/twin && uvicorn twin.app.main:app --port 8090      # terminal 1
npm run dev:gateway                                            # 8080
npm run start -w services/media-worker                         # 8091, needs MEDIA_WORKER_URL=http://127.0.0.1:8091 in .env.local to enable uploads
npm run dev:web                                                # 3000
```

Notes that cost time before:
- Gateway startup throws without `SESSION_SIGNING_KEY` (>= 32 chars), `APPROVAL_HMAC_KEY` (>= 32), `PUBLIC_ORIGINS`, and `META_API_KEY` unless `MOCK_META=true`.
- `LIVE_RUNS_ENABLED` is **true when unset**. `.env.local` currently sets it false; keep it that way until you decide to spend.
- Node 24 runs TS directly: no parameter properties, no enums, use `.ts` import suffixes.
- Keep your shell's cwd out of `apps/web/.next`.
- `scripts/build-hud.mjs` must run before `next build` (the `prebuild`/`predev` hooks do it).
- Line endings are mixed: gateway `app.ts`, most gateway files and `Workbench.tsx`, `api.ts`, `globals.css`, `StartLive.tsx` are CRLF in the working tree (git normalises with a warning); `replay/*`, twin Python and newer files are LF. Match the file you edit.
- Large python heredocs inside shell commands fail to parse on this setup; write a script file instead.

## 3. Deploys

**Render (hosted demo, replay-only).** The service builds `deploy/render/Dockerfile` from branch `deploy/render`. That branch = `build/wip` at some commit + one commit that force-adds `replays/` (18 MB, PUBLIC run, gitignored elsewhere). Auto-deploy is off.

To redeploy after changing code:
```bash
git worktree add ../cs-deploy deploy/render        # or reuse C:/cs-deploy if it still exists
cd ../cs-deploy && git cherry-pick <sha from build/wip>     # or: git merge build/wip
git push origin deploy/render
curl -X POST -H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json" -d '{"clearCache":"do_not_clear"}' https://api.render.com/v1/services/srv-dbjmjas9v7es73ai13i0/deploys
```
Poll `GET /v1/services/<id>/deploys/<deployId>` for `live`; logs: `GET /v1/logs?ownerId=tea-dbjm7dnf3r2c73cgjk10&resource=srv-dbjmjas9v7es73ai13i0&limit=60&direction=backward`.

Env on the service: `LIVE_RUNS_ENABLED=false`, `MOCK_META=true`, `SESSION_SIGNING_KEY`, `APPROVAL_HMAC_KEY`, `ADMIN_TOKEN` (random, generated at creation and not stored anywhere else: read or reset it in the Render dashboard). `PUBLIC_ORIGINS` falls back to `RENDER_EXTERNAL_URL`. No Meta or Baseten key is on Render.

Things learned: (a) the first deploy failed with `caddy: Operation not permitted` because the official binary has `cap_net_bind_service` and the container runs as non-root; the Dockerfile now rewrites the binary as a plain file. (b) Pages and API must share one origin because the session cookie is `SameSite=Strict`; that is why Caddy fronts both and `NEXT_PUBLIC_*` are empty (the browser then uses the page origin for REST, WS, ASR and HUD). (c) Free plan sleeps when idle and has an ephemeral disk. (d) A local `docker build` of this image stalled for 30+ minutes on `npm ci` in Docker Desktop; Render's builder did it in about 1 minute, so the stall was local networking.

**What a real (live-run) deployment needs, not done:** a host that can run the twin, the sandbox launcher (Docker socket) and the media worker with ffmpeg; one registrable domain for web and gateway (TR-2); `LIVE_RUNS_ENABLED` and model keys set there; the replay publisher (item 1 above) if bundles should move to a CDN.

## 4. Rules that were set for this project (keep following them)

- **Spend**: live runs are off. Do not run a live run (placebo, HUD H4/H5/HE, BYO verification) without the owner's explicit approval. A BYO run costs about $0.09 for SAM (3 concepts x 150 frames) plus about $0.05 diagnosis. Never bypass `VISITOR_CAP` (2 live runs per hour), the daily cap or the kill switch.
- **No fake stuff**: test against the real stack. No judge-tuning, mutation-run or validation documents (`docs/validation/*.md` must not exist); `/about` has no validation tables; do not change `evaluate.py` thresholds; the twin and mutation code stay. Never recreate `sandbox/harness/run_tests.py`.
- **Data classes**: CONFIDENTIAL data never goes to a Contributor or partner endpoint and never to Modal. Raw audio never goes to muse-spark-1.3 (FR-VOI-4). Only canonical intent tokens are PUBLIC. A BYO file's name is never stored or logged; a BYO run is never published as a replay.
- **Modal** is for tests only; synthesis stays on local Docker; the narrow seccomp rule applies to synthesis containers only (D-10). Muse is installed only in Docker and Modal image builds.
- **Secrets**: only in the gitignored `.env.local` (names only in `.env.example`). No key reaches the browser; only the two `NEXT_PUBLIC_*` origins are exposed. Run a secret scan before every push:
  `(git diff --name-only; git ls-files --others --exclude-standard) | sort -u | grep -v package-lock | xargs grep -nIE "(ghp_|github_pat_|sk-[A-Za-z0-9]{16,}|rnd_[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY)"` (known harmless hits: `replay/record.ts:58`, `replay.test.ts:163`, package-lock hashes, `build-hud.test.mjs:14`).
- **Push**: `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never GIT_ASKPASS=echo git -c credential.interactive=false push origin build/wip`. Never write a token into git config or a file.
- Do not put the replay bundle on `build/wip` or `main`; it lives only on `deploy/render`.
- Diagnosis per-attempt cap is 240 s; BUDGET_OVERRUN follows TECHNICAL line 811.

## 5. Bring-your-own clip: what to know before extending it

Flow and code: web `ByoPanel.tsx` + `lib/session/byo.ts` (client checks, privacy notice from PRD 17.4) -> `POST /api/sessions/:id/clips` (`services/gateway/src/upload.ts`, 100 MB cap, `consentAt` required before the file part) -> media worker normalize -> `perceive` with optional `markerSizeMm`/`mmPerPx` -> `diagnose` -> run ends ABORTED, reason `BYO_DIAGNOSED` (`byo.ts` in the gateway). `GET /api/scenarios` reports `uploads: Boolean(media worker configured)`.

Known limits: 750-frame / 25 s cap for three concepts (cost guard); the concept plan is S1's, so a generic video is BLOCKED at the precheck; no scale means pixel units; inline processing, not the Files API; the BYO panel has been verified by unit tests and typecheck but **not yet by a click-through in a real browser against a running media worker** (the hosted demo has none). Do that locally with `MEDIA_WORKER_URL` set.

## 6. Open questions for the owner

1. Which host for live runs, and which domain (TR-2)?
2. Approve a budget for the live checks in section 1 item 4?
3. Add a LICENSE file (MIT per pyproject)?

## 7. Security to-do (do this now, the repo is public)

- Revoke both GitHub personal access tokens that were pasted during development (including the one pasted into the chat session).
- Revoke or rotate the Render API key that was pasted to create the service (it can create, change and delete services in your workspace).
- Rotate the Baseten and Meta keys that live in `.env.local`.
- Treat the Modal token in `~/.modal.toml` as local-only; do not copy it anywhere.
