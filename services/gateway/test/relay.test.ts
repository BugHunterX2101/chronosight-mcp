// The ASR relay (DESIGN §15) against a local WebSocket server that speaks the upstream's wire format
// (shapes taken from the real service in the SP-8 probe). The browser side is a real `ws` client, so
// framing, close codes and ordering are the ones a browser would see.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { RunState } from "@chronosight/run-model";
import { Session } from "../src/session.ts";
import { serveRelay, type RelayOptions } from "../src/asr/relay.ts";
import { FRAME_BYTES } from "../src/asr/protocol.ts";

const KEY = "sk-test-key-0000000000000000";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for condition");
    await wait(5);
  }
}

interface Upstream {
  url: string;
  sockets: WebSocket[];
  /** Everything each upstream connection received, in order. */
  got: { text: string[]; binary: Buffer[] }[];
  close: () => Promise<void>;
}

async function upstream(): Promise<Upstream> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const u: Upstream = { url: `ws://127.0.0.1:${port}`, sockets: [], got: [], close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }) };
  wss.on("connection", (ws, req) => {
    expect(req.url).toBe("/asr/realtime");
    const rec = { text: [] as string[], binary: [] as Buffer[] };
    u.sockets.push(ws);
    u.got.push(rec);
    ws.on("message", (d, bin) => {
      if (bin) rec.binary.push(d as Buffer);
      else {
        const s = d.toString();
        rec.text.push(s);
        if (rec.text.length === 1) ws.send(JSON.stringify({ sessionId: `voyager/duplex/${u.sockets.length}` }));
        if (JSON.parse(s).type === "endStream") ws.close(1000, "No more transcript segments");
      }
    });
  });
  return u;
}

const frame = (n: number) => Buffer.alloc(FRAME_BYTES, n);

describe("relay", () => {
  let dir: string;
  let up: Upstream;
  let relayWss: WebSocketServer;
  let session: Session;
  let state: RunState | null;
  let spent: number[];
  let alerts: string[];
  let browser: WebSocket;
  let inbox: Record<string, unknown>[];

  async function start(extra: Partial<RelayOptions> = {}): Promise<void> {
    relayWss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => relayWss.once("listening", r));
    relayWss.on("connection", (client) => {
      serveRelay(client, {
        session,
        apiKey: KEY,
        base: up.url.replace("ws:", "http:"),
        concepts: ["forearm", "elbow", "carriage-rail"],
        connect: (url) => new WebSocket(url),
        onSpend: (usd) => spent.push(usd),
        onAlert: (m) => alerts.push(m),
        ...extra,
      });
    });
    browser = new WebSocket(`ws://127.0.0.1:${(relayWss.address() as { port: number }).port}`);
    browser.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise((r) => browser.once("open", r));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "relay-"));
    up = await upstream();
    session = new Session({ id: "ses_01TESTTESTTESTTESTTESTTEST", mode: "replay", scenarioId: "s1", visitorKey: "v", dataDir: dir, ttlMs: 60_000 });
    state = null;
    Object.defineProperty(session, "runState", { get: () => state });
    spent = [];
    alerts = [];
    inbox = [];
  });

  afterEach(async () => {
    browser?.terminate();
    for (const c of relayWss?.clients ?? []) c.terminate();
    await new Promise((r) => relayWss?.close(() => r(null)));
    await up.close();
    session.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const send = (u: number, m: object) => up.sockets[u]!.send(JSON.stringify(m));
  const ready = () => until(() => inbox.some((m) => m.type === "asr.ready"));

  it("sends the Bearer handshake first, announces ready, then forwards audio in order", async () => {
    await start();
    await until(() => up.got.length === 1 && up.got[0]!.text.length === 1);
    const hs = JSON.parse(up.got[0]!.text[0]!);
    expect(hs.authorization).toEqual({ accessToken: `Bearer ${KEY}` });
    expect(hs.keywords).toContain("elbow");
    await ready();
    browser.send(frame(1));
    browser.send(frame(2));
    await until(() => up.got[0]!.binary.length === 2);
    expect(up.got[0]!.binary.map((b) => b[0])).toEqual([1, 2]);
  });

  it("holds audio sent before the handshake is acknowledged and delivers it after", async () => {
    await start();
    browser.send(frame(7));
    browser.send(frame(8));
    await until(() => up.got[0]?.binary.length === 2);
    expect(up.got[0]!.binary.map((b) => b[0])).toEqual([7, 8]);
  });

  it("maps transcript to partial and speechComplete to final with the parsed intent", async () => {
    state = "AWAITING_APPROVAL_1";
    await start();
    await ready();
    send(0, { type: "speechStart", audioProcessedMs: 0, turnId: 0 });
    send(0, { type: "transcript", transcript: "don't", final: false, audioProcessedMs: 800 });
    send(0, { type: "transcript", transcript: "don't approve that.", final: false, audioProcessedMs: 2000 });
    send(0, { type: "speechEnd", audioProcessedMs: 3000, turnId: 0 });
    send(0, { type: "speechComplete", audioProcessedMs: 3000, turnId: 0, transcript: "don't approve that." });
    send(0, { type: "transcript", transcript: "", final: true, audioProcessedMs: 3840 });
    await until(() => inbox.some((m) => m.type === "transcript.final"));
    await wait(30);
    const partials = inbox.filter((m) => m.type === "transcript.partial");
    expect(partials.map((m) => m.text)).toEqual(["don't", "don't approve that."]);
    expect(partials.every((m) => m.turnId === "0")).toBe(true);
    expect(inbox.find((m) => m.type === "transcript.final")).toMatchObject({ turnId: "0", text: "don't approve that.", intent: { kind: "reject" }, dataClass: "CONFIDENTIAL" });
    expect(inbox.filter((m) => m.type === "transcript.final")).toHaveLength(1); // the empty end-of-stream marker is not a turn
  });

  it("an approval is an intent, never an action, and the session log holds the token only", async () => {
    state = "AWAITING_APPROVAL_1";
    const logged: unknown[] = [];
    session.subscribe((e) => logged.push(e));
    await start();
    await ready();
    send(0, { type: "speechStart", audioProcessedMs: 0, turnId: 4 });
    send(0, { type: "speechComplete", audioProcessedMs: 900, turnId: 4, transcript: "Approve." });
    await until(() => logged.length === 1 && inbox.some((m) => m.type === "transcript.final"));
    expect(inbox.find((m) => m.type === "transcript.final")).toMatchObject({ intent: { kind: "approve" }, dataClass: "PUBLIC" });
    const e = logged[0] as { type: string; data: Record<string, unknown> };
    expect(e.type).toBe("transcript.final");
    expect(e.data).toEqual({ turnId: "4", intent: "approve", dataClass: "PUBLIC" });
    expect(JSON.stringify(e)).not.toContain("Approve.");
  });

  it("resolves inspect targets only to the scenario's concept slugs", async () => {
    state = "AWAITING_QUESTION";
    await start();
    await ready();
    send(0, { type: "speechComplete", audioProcessedMs: 1, turnId: 0, transcript: "Look at the elbow." });
    await until(() => inbox.some((m) => m.type === "transcript.final"));
    expect(inbox.find((m) => m.type === "transcript.final")).toMatchObject({ intent: { kind: "inspect", target: "elbow" } });
  });

  it("closes the browser with 1008 on a frame of the wrong size", async () => {
    await start();
    await ready();
    const closed = new Promise<number>((r) => browser.once("close", (c) => r(c)));
    browser.send(Buffer.alloc(100));
    expect(await closed).toBe(1008);
  });

  it("closes the browser with 1008 when audio runs more than 5 s ahead of real time", async () => {
    await start();
    const closed = new Promise<number>((r) => browser.once("close", (c) => r(c)));
    for (let i = 0; i < 80; i++) browser.send(frame(0)); // 6.4 s of audio sent at once
    expect(await closed).toBe(1008);
  });

  it("sends endStream upstream when the browser leaves, and reports the audio cost", async () => {
    await start();
    await ready();
    for (let i = 0; i < 10; i++) browser.send(frame(1));
    await until(() => up.got[0]!.binary.length === 10);
    browser.close();
    await until(() => up.got[0]!.text.some((t) => JSON.parse(t).type === "endStream"));
    await until(() => spent.length === 1);
    expect(spent[0]).toBeCloseTo(((10 * 80) / 3_600_000) * 0.18, 12);
  });

  it("an upstream 1008 is final: voice unavailable, the browser is closed, the team is alerted, no key is leaked", async () => {
    await start();
    await until(() => up.sockets.length === 1);
    up.sockets[0]!.close(1008, "Bad Request");
    await until(() => inbox.some((m) => m.type === "asr.notice"));
    expect(inbox.find((m) => m.type === "asr.notice")).toMatchObject({ level: "error", message: "Voice unavailable, type instead" });
    expect(alerts).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain(KEY);
    await wait(100);
    expect(up.sockets).toHaveLength(1); // never retried
  });

  it("an upstream 1013 backs off and reconnects, keeping the audio sent meanwhile", async () => {
    await start({ random: () => 0 }); // zero jitter: reconnect at once
    await ready();
    up.sockets[0]!.close(1013, "busy");
    await until(() => up.sockets.length === 2);
    browser.send(frame(5));
    await until(() => up.got[1]!.binary.length === 1);
    expect(up.got[1]!.binary[0]![0]).toBe(5);
  });

  it("a max-duration 1011 opens a new session without telling the user", async () => {
    await start();
    await ready();
    up.sockets[0]!.close(1011, "Max session duration reached");
    await until(() => up.sockets.length === 2);
    await until(() => inbox.filter((m) => m.type === "asr.ready").length === 2);
    expect(inbox.some((m) => m.type === "asr.notice")).toBe(false);
  });
});
