// Static file replies with single-range support: the <video> element seeks with Range, and the replay
// player fetches the first frames of a .csmk before the rest (DESIGN §24.3). Callers pass a path they
// have already validated; this module only reads it.

import { createReadStream, statSync } from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".diff": "text/plain; charset=utf-8",
  ".sse": "text/event-stream; charset=utf-8",
  ".csmk": "application/octet-stream",
  ".idx": "application/octet-stream",
};

export function contentType(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot < 0 ? undefined : TYPES[path.slice(dot).toLowerCase()]) ?? "application/octet-stream";
}

/** One `bytes=` range against a file of `size` bytes; null when it cannot be satisfied. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? { start, end } : null;
}

export function sendFile(req: FastifyRequest, reply: FastifyReply, path: string, o: { cache: string; type?: string }): FastifyReply {
  const size = statSync(path).size;
  reply.header("accept-ranges", "bytes").header("cache-control", o.cache).header("access-control-expose-headers", "content-range, content-length, accept-ranges");
  reply.type(o.type ?? contentType(path));
  const range = req.headers.range;
  if (typeof range === "string") {
    const r = parseRange(range, size);
    if (!r) return reply.code(416).header("content-range", `bytes */${size}`).send();
    return reply
      .code(206)
      .header("content-range", `bytes ${r.start}-${r.end}/${size}`)
      .header("content-length", r.end - r.start + 1)
      .send(createReadStream(path, { start: r.start, end: r.end }));
  }
  return reply.header("content-length", size).send(createReadStream(path));
}
