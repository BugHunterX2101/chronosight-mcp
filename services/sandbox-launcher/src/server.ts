// Launcher API (TECHNICAL §7.6) over the launcher-sock unix socket, or a named pipe on a
// Windows dev machine. There is no TCP listener. Every body is strict; anything else is 400.

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Docker, DockerError } from "./docker.ts";
import { ContainerId, LaunchError, Launcher, type LauncherConfig } from "./launcher.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const here = dirname(fileURLToPath(import.meta.url));

export function defaultListenPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "\\\\.\\pipe\\chronosight-launcher" : "/run/launcher/launcher.sock";
}

const PIPE_RE = /^\\\\[.?]\\pipe\\[^\\/]+$/;

/**
 * LAUNCHER_SOCKET (TECHNICAL §9.1), the same rule the gateway applies: a named pipe on Windows,
 * an absolute Unix socket path elsewhere, or unset for the default. A malformed value stops the
 * launcher at startup instead of leaving it listening where the gateway will never look.
 */
export function listenPathFromEnv(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const v = env.LAUNCHER_SOCKET?.trim();
  if (!v) return defaultListenPath(platform);
  if (platform === "win32" ? !PIPE_RE.test(v) : !v.startsWith("/")) {
    const want = platform === "win32" ? String.raw`a named pipe such as \\.\pipe\chronosight-launcher` : "an absolute Unix socket path";
    throw new Error(`LAUNCHER_SOCKET must be ${want}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function readKey(env: NodeJS.ProcessEnv): string | null {
  if (env.META_API_KEY_FILE) return readFileSync(env.META_API_KEY_FILE, "utf8").trim() || null;
  return env.META_API_KEY?.trim() || null;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): LauncherConfig {
  const image = env.SANDBOX_IMAGE?.trim();
  if (!image) throw new Error("SANDBOX_IMAGE is required");
  return {
    image,
    egressProxyUrl: env.EGRESS_PROXY_URL?.trim() || "http://egress-proxy:3128",
    metaApiKey: readKey(env),
    scenariosDir: env.SCENARIOS_DIR?.trim() || resolve(here, "../../twin/twin/scenarios"),
    network: env.SANDBOX_NETWORK?.trim() || "sbx",
    museServe: museServeArgv,
  };
}

/**
 * DESIGN §18.11 against the CLI that ships (1.4.14): the model and contributor mode follow
 * the data class. The agent's shell never needs the network, so it gets `restricted`
 * whatever the class. Approval mode is chosen on the wire, so it has no flag here, and
 * `high` is already the default effort for both pins.
 */
export function museServeArgv(dataClass: "PUBLIC" | "CONFIDENTIAL"): readonly string[] {
  const pub = dataClass === "PUBLIC";
  return [
    "muse", "serve",
    "--provider", "meta",
    "--model", pub ? "muse-spark-1.3-contributor" : "muse-spark-1.3",
    "--contributor-mode", pub ? "on" : "off",
    "--sandbox-network", "restricted",
    "--disable-request-user-input",
  ];
}

/** Keeps the Meta key out of anything the launcher logs or returns. */
export function redactor(secret: string | null): (s: string) => string {
  return secret ? (s) => s.split(secret).join("[REDACTED]") : (s) => s;
}

export interface ErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  stage: "ST-9";
  requestId: string;
}

function errorOf(e: unknown, requestId: string, redact: (s: string) => string): { status: number; body: ErrorBody } {
  const body = (code: string, message: string, retryable: boolean): ErrorBody => ({ code, message: redact(message), retryable, stage: "ST-9", requestId });
  if (e instanceof LaunchError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "WRONG_KIND" ? 409 : 400;
    return { status, body: body(`LAUNCH_${e.code}`, e.message, false) };
  }
  if (e instanceof DockerError) return { status: 502, body: body("LAUNCH_DOCKER", e.message, e.status >= 500) };
  return { status: 500, body: body("LAUNCH_INTERNAL", e instanceof Error ? e.message : String(e), false) };
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(buf.length) }).end(buf);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new LaunchError("BAD_REQUEST", "content-type must be application/json");
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw new LaunchError("BAD_REQUEST", "body over 1 MB");
    parts.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new LaunchError("BAD_REQUEST", "body is not JSON");
  }
}

/** `<prefix><64 hex>` → the id; null when the path has another prefix. */
function idFrom(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix)) return null;
  const id = path.slice(prefix.length);
  if (!ContainerId.safeParse(id).success) throw new LaunchError("BAD_REQUEST", "bad container id");
  return id;
}

export interface ServerDeps {
  launcher: Launcher;
  docker: Docker;
  image: string;
  log: (line: Record<string, unknown>) => void;
  redact: (s: string) => string;
}

export function createLauncherServer(d: ServerDeps) {
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const path = (req.url ?? "/").split("?")[0]!;
    const started = Date.now();
    void route(req.method ?? "", path)
      .then(([status, body]) => send(res, status, body))
      .catch((e: unknown) => {
        const { status, body } = errorOf(e, requestId, d.redact);
        d.log({ requestId, code: body.code, message: body.message });
        send(res, status, body);
      })
      .finally(() => d.log({ requestId, method: req.method, path, status: res.statusCode, ms: Date.now() - started }));

    async function route(method: string, p: string): Promise<[number, unknown?]> {
      if (method === "GET" && p === "/healthz") {
        let docker = false;
        let imagePresent = false;
        try {
          await d.docker.call("GET", "/_ping");
          docker = true;
          imagePresent = (await d.docker.call("GET", `/images/${encodeURIComponent(d.image)}/json`, undefined, [404])).status === 200;
        } catch {
          // reported as false below
        }
        return [docker && imagePresent ? 200 : 503, { docker, imagePresent, sandboxes: d.launcher.list().length }];
      }
      if (method === "POST" && p === "/launch") return [201, await d.launcher.launch(await readJson(req))];
      let id: string | null;
      if (method === "POST" && (id = idFrom(p, "/run-tests/"))) return [200, await d.launcher.runTests(id)];
      if (method === "POST" && (id = idFrom(p, "/collect/"))) return [200, await d.launcher.collect(id)];
      if (method === "DELETE" && (id = idFrom(p, "/containers/"))) {
        await d.launcher.destroy(id);
        return [204];
      }
      if (p.startsWith("/attach/")) throw new LaunchError("BAD_REQUEST", "attach needs an HTTP upgrade");
      throw new LaunchError("NOT_FOUND", `no route ${method} ${p}`);
    }
  });

  // GET /attach/:id with `Upgrade: tcp` becomes a raw duplex bridged to `muse serve` stdio.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const requestId = randomUUID();
    const path = (req.url ?? "/").split("?")[0]!;
    const fail = (e: unknown) => {
      const { status, body } = errorOf(e, requestId, d.redact);
      d.log({ requestId, method: req.method, path, status, code: body.code, message: body.message });
      const buf = Buffer.from(JSON.stringify(body));
      socket.end(`HTTP/1.1 ${status} Error\r\ncontent-type: application/json\r\ncontent-length: ${buf.length}\r\nconnection: close\r\n\r\n${buf.toString("utf8")}`);
    };
    let containerId: string;
    try {
      const id = req.method === "GET" ? idFrom(path, "/attach/") : null;
      if (!id) throw new LaunchError("NOT_FOUND", `no route ${req.method} ${path}`);
      containerId = id;
    } catch (e) {
      fail(e);
      return;
    }
    d.launcher
      .attach(containerId, (chunk) => d.log({ requestId, containerId, stderr: d.redact(chunk.toString("utf8")) }))
      .then((stdio) => {
        socket.write("HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n");
        d.log({ requestId, method: "GET", path, status: 101 });
        if (head.length > 0) stdio.write(head);
        socket.pipe(stdio).pipe(socket);
        const close = () => {
          stdio.destroy();
          socket.destroy();
        };
        socket.on("error", close).on("close", close);
        stdio.on("error", close).on("close", close);
      })
      .catch(fail);
  });

  return server;
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const docker = new Docker();
  const launcher = new Launcher(cfg, docker);
  const log = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...line }) + "\n");

  log({ event: "sweep", removed: await launcher.sweep() });

  const listenPath = listenPathFromEnv();
  if (process.platform !== "win32" && existsSync(listenPath)) unlinkSync(listenPath);
  const server = createLauncherServer({ launcher, docker, image: cfg.image, log, redact: redactor(cfg.metaApiKey) });
  server.listen(listenPath, () => {
    if (process.platform !== "win32") chmodSync(listenPath, 0o660);
    log({ event: "listening", socket: listenPath, image: cfg.image, network: cfg.network, key: cfg.metaApiKey ? "present" : "absent" });
  });

  const stop = () => {
    server.close();
    void launcher.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    process.stderr.write(`launcher: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
