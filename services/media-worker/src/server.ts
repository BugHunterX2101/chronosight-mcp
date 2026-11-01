import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTools, MediaError, normalizeClip, run as runTool, type Tools } from "./media.ts";

// The media worker (DESIGN §6, §11; TECHNICAL TH-12). It is reachable only on the internal network and only by the
// gateway, which is why it has no authentication: the network is the control (TD-4). It reads an upload from the
// shared scratch directory by clip id and writes the normalized clip beside it. One job runs at a time, because the
// container it ships in has one CPU.

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const scratch = resolve(root, process.env.MEDIA_SCRATCH_DIR || "data/media-scratch");
const port = Number(process.env.MEDIA_WORKER_PORT || 8091);
const host = process.env.MEDIA_WORKER_HOST || "127.0.0.1";
const tools: Tools = defaultTools();

const log = (event: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), service: "media-worker", event, ...fields })}\n`);
};

let queue: Promise<unknown> = Promise.resolve();
/** Runs jobs strictly one after another; a failed job does not stop the next. */
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
};

let version: Promise<string> | undefined;
const ffmpegVersion = (): Promise<string> => (version ??= runTool(tools.ffmpeg, ["-version"], 10_000).then((r) => r.stdout.split("\n")[0] ?? "unknown"));

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4096) {
        reject(new MediaError("BAD_CLIP_ID", "request body too large"));
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(parts).toString("utf8")));
      } catch {
        reject(new MediaError("BAD_CLIP_ID", "request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === "GET" && req.url === "/healthz") return send(res, 200, { ok: true, ffmpeg: await ffmpegVersion() });
      if (req.method === "POST" && req.url === "/normalize") {
        const body = await readJson(req);
        const clipId = typeof body === "object" && body !== null && "clipId" in body && typeof body.clipId === "string" ? body.clipId : "";
        const result = await serial(() => normalizeClip(scratch, clipId, tools));
        // The exact command line is logged per clip (FR-CAP-2). The paths in it name the clip, not the person.
        log("clip.normalized", { clipId, command: result.command, frames: result.frames, bytes: result.bytes, durationS: result.durationS });
        return send(res, 200, { ok: true, ...result });
      }
      send(res, 404, { ok: false, code: "NOT_FOUND", message: "no such route" });
    } catch (err) {
      if (err instanceof MediaError) {
        log("clip.rejected", { code: err.code });
        return send(res, 422, { ok: false, code: err.code, message: err.message });
      }
      log("error", { message: err instanceof Error ? err.message : String(err) });
      send(res, 500, { ok: false, code: "INTERNAL", message: "The media worker failed." });
    }
  })();
});

server.listen(port, host, () => log("listening", { host, port, scratch }));
