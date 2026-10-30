// Minimal Docker Engine API client, spoken over the daemon's local socket. The launcher
// is the only process that holds this socket (DL-22), and it needs only JSON calls,
// archive upload, exec, and hijacked stdio, so there is no SDK dependency.

import { request, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

const API = "/v1.44";

export function defaultSocketPath(): string {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  if (host?.startsWith("npipe://")) return "\\\\" + host.slice("npipe://".length).replace(/^\/+/, "").replace(/\//g, "\\");
  return process.platform === "win32" ? "\\\\.\\pipe\\docker_engine" : "/var/run/docker.sock";
}

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ExecResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

async function collect(s: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

function messageOf(text: string): string {
  try {
    return (JSON.parse(text) as { message?: string }).message ?? text;
  } catch {
    return text.trim();
  }
}

/** Splits Docker's multiplexed stdio stream: 8-byte frame headers [stream, 0, 0, 0, size u32 BE]. */
export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);
  private readonly emit: (stream: number, chunk: Buffer) => void;
  constructor(emit: (stream: number, chunk: Buffer) => void) {
    this.emit = emit;
  }

  push(b: Buffer): void {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, b]) : b;
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      this.emit(this.buf[0]!, this.buf.subarray(8, 8 + size));
      this.buf = this.buf.subarray(8 + size);
    }
  }
}

export class Docker {
  private readonly socketPath: string;
  constructor(socketPath = defaultSocketPath()) {
    this.socketPath = socketPath;
  }

  private raw(method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path: API + path,
          headers: body ? { ...headers, "content-length": String(body.length) } : headers,
        },
        resolve,
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  /** A JSON call. Statuses in `ok` are returned instead of thrown (e.g. 404 on an idempotent delete). */
  async call<T = unknown>(method: string, path: string, body?: unknown, ok: readonly number[] = []): Promise<{ status: number; body: T }> {
    const buf = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const res = await this.raw(method, path, buf ? { "content-type": "application/json" } : {}, buf);
    const text = (await collect(res)).toString("utf8");
    const status = res.statusCode ?? 0;
    if (status >= 400 && !ok.includes(status)) throw new DockerError(status, `${method} ${path}: ${status} ${messageOf(text)}`);
    let parsed: unknown = null;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status, body: parsed as T };
  }

  /** Extracts a tar archive into `path` inside the container. */
  async putArchive(id: string, path: string, tar: Buffer): Promise<void> {
    const res = await this.raw("PUT", `/containers/${id}/archive?path=${encodeURIComponent(path)}`, { "content-type": "application/x-tar" }, tar);
    const text = (await collect(res)).toString("utf8");
    const status = res.statusCode ?? 0;
    if (status >= 400) throw new DockerError(status, `put archive ${path}: ${status} ${messageOf(text)}`);
  }

  /** Runs a command to completion and returns its exit code and output. */
  async exec(id: string, cmd: readonly string[], opts: { workingDir?: string; env?: readonly string[] } = {}): Promise<ExecResult> {
    const { body: created } = await this.call<{ Id: string }>("POST", `/containers/${id}/exec`, {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
      WorkingDir: opts.workingDir,
      Env: opts.env,
    });
    const start = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const res = await this.raw("POST", `/exec/${created.Id}/start`, { "content-type": "application/json" }, start);
    const status = res.statusCode ?? 0;
    const raw = await collect(res);
    if (status >= 400) throw new DockerError(status, `exec start: ${status} ${messageOf(raw.toString("utf8"))}`);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    new Demuxer((s, c) => (s === 2 ? err : out).push(c)).push(raw);
    const { body: info } = await this.call<{ ExitCode: number | null }>("GET", `/exec/${created.Id}/json`);
    return { exitCode: info.ExitCode ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) };
  }

  /**
   * Starts a command with stdin, stdout and stderr on one hijacked connection. The
   * returned stream carries stdin (writes) and stdout (reads); stderr goes to `onStderr`.
   */
  async execStream(id: string, cmd: readonly string[], onStderr: (chunk: Buffer) => void): Promise<Duplex> {
    const { body: created } = await this.call<{ Id: string }>("POST", `/containers/${id}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Cmd: cmd,
    });
    const { socket, head } = await this.upgrade(`/exec/${created.Id}/start`, { Detach: false, Tty: false });
    return stdioDuplex(socket, head, onStderr);
  }

  private upgrade(path: string, body: unknown): Promise<{ socket: Socket; head: Buffer }> {
    return new Promise((resolve, reject) => {
      const buf = Buffer.from(JSON.stringify(body));
      const req = request({
        socketPath: this.socketPath,
        method: "POST",
        path: API + path,
        headers: { "content-type": "application/json", "content-length": String(buf.length), connection: "Upgrade", upgrade: "tcp" },
      });
      req.on("upgrade", (_res, socket, head) => resolve({ socket: socket as Socket, head }));
      req.on("response", (res) => {
        void collect(res).then((b) => reject(new DockerError(res.statusCode ?? 0, `${path}: ${res.statusCode} ${messageOf(b.toString("utf8"))}`)));
      });
      req.on("error", reject);
      req.end(buf);
    });
  }
}

function stdioDuplex(socket: Socket, head: Buffer, onStderr: (chunk: Buffer) => void): Duplex {
  const duplex: Duplex = new Duplex({
    write(chunk: Buffer, _enc, cb) {
      socket.write(chunk, cb);
    },
    final(cb) {
      socket.end();
      cb();
    },
    read() {
      socket.resume();
    },
    destroy(err, cb) {
      socket.destroy();
      cb(err);
    },
  });
  const demux = new Demuxer((s, c) => {
    if (s === 2) onStderr(c);
    else if (!duplex.push(c)) socket.pause();
  });
  socket.on("data", (b: Buffer) => demux.push(b));
  socket.on("end", () => duplex.push(null));
  socket.on("error", (e) => duplex.destroy(e));
  if (head.length > 0) demux.push(head);
  return duplex;
}
