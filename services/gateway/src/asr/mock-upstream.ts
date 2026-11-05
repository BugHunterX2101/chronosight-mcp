// In-process mock ASR upstream for demo / MOCK_META / test modes (DESIGN §15).
// Allows the voice relay socket (/ws/asr/:id) to operate end-to-end even when no external
// Meta ASR credentials are provided or when running in offline/isolated environments.

import { WebSocket, WebSocketServer } from "ws";

export interface MockUpstreamServer {
  url: string;
  base: string;
  close: () => Promise<void>;
  connect: (url: string) => WebSocket;
}

const COMMAND_SEQUENCE: readonly string[] = [
  "explain the fault",
  "show the sources",
  "inspect anchor",
  "telemetry help",
];

export async function startMockAsrUpstream(): Promise<MockUpstreamServer> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const url = `ws://127.0.0.1:${port}/asr/realtime`;

  wss.on("error", () => {});

  wss.on("connection", (ws) => {
    let turnCount = 0;
    let framesReceived = 0;
    let turnActive = false;

    ws.on("error", () => {});

    ws.on("message", (data, isBinary) => {
      if (!isBinary) {
        try {
          const text = data.toString();
          const parsed = JSON.parse(text) as { authorization?: unknown; type?: string };
          // 1. Initial handshake response: sends { sessionId } without type
          if (parsed.authorization) {
            ws.send(JSON.stringify({ sessionId: `mock_asr_session_${Date.now()}` }));
            return;
          }
          if (parsed.type === "endStream") {
            ws.close(1000, "end of stream");
            return;
          }
        } catch {
          // Ignore parse errors on mock server
        }
        return;
      }

      // Binary audio PCM received (80 ms frames at 24 kHz)
      framesReceived += 1;

      // After accumulating speech frames (~12 frames = ~960 ms), simulate a recognized voice command
      if (framesReceived % 25 === 12 && !turnActive) {
        turnActive = true;
        turnCount += 1;
        const turnId = String(turnCount);
        const text = COMMAND_SEQUENCE[(turnCount - 1) % COMMAND_SEQUENCE.length];
        ws.send(JSON.stringify({ type: "speechStart", turnId }));
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", turnId, transcript: text, final: false }));
          }
        }, 150);
        setTimeout(() => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "speechComplete", turnId, transcript: text }));
            turnActive = false;
          }
        }, 400);
      }
    });
  });

  return {
    url,
    base,
    connect: (targetUrl: string) => new WebSocket(targetUrl || url),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            // Ignore termination errors on shutdown
          }
        }
        wss.close(() => resolve());
      }),
  };
}
