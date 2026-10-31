// Client for services/sandbox-launcher (DL-22, TECHNICAL §5.6). The launcher is the only
// holder of the Docker socket; the gateway reaches it over a unix socket (a named pipe on
// Windows) and can only name a kind, a candidate and the target files. Bodies mirror
// services/sandbox-launcher/src/launcher.ts (the launcher rejects unknown keys).

import { request } from "node:http";
import type { DataClass, PatchSpec } from "@chronosight/run-model";

export interface LaunchBody {
  kind: "synthesis" | "test";
  candidateId: "c1" | "c2" | "c3";
  scenario: string;
  dataClass: DataClass;
  patchSpec: PatchSpec;
  patchSpecHash: string;
  files: Record<string, string>;
}

export interface Launched {
  containerId: string;
  workspaceVolume: string;
}

export interface Collected {
  files: Record<string, string>;
  changedPaths: string[];
  diff: string;
}

export interface HarnessMetrics {
  overshootPct: number | null;
  settleSec: number | null;
  sse: number | null;
  /** S1: ms of warm-up and clip with the encoder filter off; 0 when FILT is rewritten after every reset (DESIGN §20.2) */
  filtOffMs?: number | null;
  error: string | null;
}

export interface TestRun {
  exitCode: number;
  junitXml: string;
  stdoutTail: string;
  metrics: HarnessMetrics | null;
}

/** The launcher's error body (`{code, message, retryable, stage, requestId}`), or a transport failure. */
export class LauncherError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status: number, retryable: boolean) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/** The launcher operations the synthesizer uses; tests supply a fake. */
export interface Launcher {
  launch(body: LaunchBody): Promise<Launched>;
  collect(containerId: string): Promise<Collected>;
  runTests(containerId: string): Promise<TestRun>;
  /** Idempotent. */
  destroy(containerId: string): Promise<void>;
}

const ID = /^[0-9a-f]{64}$/;

export class LauncherClient implements Launcher {
  readonly socketPath: string;
  readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = 60_000) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  launch(body: LaunchBody): Promise<Launched> {
    return this.call<Launched>("POST", "/launch", body);
  }

  collect(id: string): Promise<Collected> {
    return this.call<Collected>("POST", `/collect/${checked(id)}`);
  }

  runTests(id: string): Promise<TestRun> {
    return this.call<TestRun>("POST", `/run-tests/${checked(id)}`);
  }

  async destroy(id: string): Promise<void> {
    await this.call("DELETE", `/containers/${checked(id)}`);
  }

  healthz(): Promise<Record<string, unknown>> {
    return this.call("GET", "/healthz");
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const buf = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const req = request(
        {
          socketPath: this.socketPath, method, path, timeout: this.timeoutMs,
          headers: buf ? { "content-type": "application/json", "content-length": String(buf.length) } : {},
        },
        (res) => {
          const parts: Buffer[] = [];
          res.on("data", (c: Buffer) => parts.push(c));
          res.on("error", reject);
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const text = Buffer.concat(parts).toString("utf8");
            let json: unknown = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              return reject(new LauncherError("LAUNCHER_BAD_RESPONSE", `${method} ${path}: ${status} with a non-JSON body`, status, false));
            }
            if (status >= 200 && status < 300) return resolve(json as T);
            const e = (json ?? {}) as { code?: string; message?: string; retryable?: boolean };
            reject(new LauncherError(e.code ?? "LAUNCHER_HTTP", `${method} ${path}: ${e.message ?? `HTTP ${status}`}`, status, e.retryable ?? status >= 500));
          });
        },
      );
      req.on("timeout", () => req.destroy(new LauncherError("LAUNCHER_TIMEOUT", `${method} ${path}: no answer in ${this.timeoutMs} ms`, 0, true)));
      req.on("error", (err) =>
        reject(err instanceof LauncherError ? err : new LauncherError("LAUNCHER_UNAVAILABLE", `${method} ${path}: ${err.message}`, 0, true)));
      req.end(buf);
    });
  }
}

function checked(id: string): string {
  if (!ID.test(id)) throw new LauncherError("LAUNCH_BAD_REQUEST", "bad container id", 400, false);
  return id;
}
