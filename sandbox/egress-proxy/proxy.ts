// Egress proxy for the patch sandbox (DESIGN §19). It is the only peer a synthesis
// container can reach on the internal `sbx` network. It opens a tunnel for
// `CONNECT api.meta.ai:443` and nothing else, and logs every attempt as one JSON line.

import { createServer } from "node:http";
import { connect } from "node:net";

const ALLOWED_HOST = "api.meta.ai";
const ALLOWED_PORT = 443;
const PORT = 3128;
/** Longer than any sandbox lives (120 s), so the proxy never outlasts the caller by much. */
const IDLE_MS = 130_000;

function log(entry: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}

const server = createServer((req, res) => {
  // Plain-HTTP proxying would let a client name any host, so only CONNECT is served.
  log({ method: req.method, target: req.url, from: req.socket.remoteAddress, allowed: false });
  res.writeHead(403, { connection: "close" }).end();
});

server.on("connect", (req, client, head) => {
  const target = (req.url ?? "").toLowerCase();
  const allowed = target === `${ALLOWED_HOST}:${ALLOWED_PORT}`;
  log({ method: "CONNECT", target, from: client.remoteAddress, allowed });
  if (!allowed) {
    client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = connect(ALLOWED_PORT, ALLOWED_HOST);
  const close = () => {
    upstream.destroy();
    client.destroy();
  };
  upstream.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", (e) => {
    log({ target, error: e.message });
    if (!client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    close();
  });
  client.on("error", close);
  upstream.setTimeout(IDLE_MS, close);
  client.setTimeout(IDLE_MS, close);
});

server.listen(PORT, () => log({ listening: PORT, allow: `${ALLOWED_HOST}:${ALLOWED_PORT}` }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
