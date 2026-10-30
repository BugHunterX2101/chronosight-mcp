// `sandbox-attach <containerId>` (TECHNICAL §5.6). The Muse SDK spawns this in place of
// `muse serve`: it upgrades GET /attach/:id on the launcher socket and then pipes its own
// stdin and stdout through, so the SDK sees an ordinary child process. The exit code tells
// the SDK how the host ended: 0 when the stream closed, 1 when the attach was refused.

import { connect, type Socket } from "node:net";

const HEADER_LIMIT = 16 * 1024;

export function launcherSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAUNCHER_SOCKET?.trim() || (process.platform === "win32" ? "\\\\.\\pipe\\chronosight-launcher" : "/run/launcher/launcher.sock");
}

/** Connects and upgrades. Resolves with the raw socket and any bytes that followed the 101. */
export function attach(socketPath: string, containerId: string): Promise<{ socket: Socket; head: Buffer }> {
  if (!/^[0-9a-f]{64}$/.test(containerId)) return Promise.reject(new Error("bad container id"));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buf = Buffer.alloc(0);
    const fail = (e: Error) => {
      socket.destroy();
      reject(e);
    };
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buf.length > HEADER_LIMIT) fail(new Error("launcher response header too large"));
        return;
      }
      socket.off("data", onData);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf.subarray(0, end).toString("latin1"))?.[1] ?? 0);
      if (status !== 101) {
        fail(new Error(`attach refused: ${status} ${buf.subarray(end + 4).toString("utf8")}`));
        return;
      }
      socket.off("error", fail);
      resolve({ socket, head: buf.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", fail);
    socket.once("connect", () => {
      socket.write(`GET /attach/${containerId} HTTP/1.1\r\nhost: launcher\r\nconnection: Upgrade\r\nupgrade: tcp\r\n\r\n`);
    });
  });
}

async function main(argv: readonly string[]): Promise<void> {
  const containerId = argv[0];
  if (!containerId || argv.length !== 1) {
    process.stderr.write("usage: sandbox-attach <containerId>\n");
    process.exit(2);
  }
  const { socket, head } = await attach(launcherSocketPath(), containerId);
  if (head.length > 0) process.stdout.write(head);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  socket.on("close", () => process.exit(0));
  socket.on("error", (e) => {
    process.stderr.write(`sandbox-attach: ${e.message}\n`);
    process.exit(1);
  });
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`sandbox-attach: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
