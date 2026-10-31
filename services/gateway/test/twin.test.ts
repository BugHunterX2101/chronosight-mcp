// TwinClient deadlines. SAM ingest decodes every mask of the clip, so it is bounded by the
// PERCEIVING stage (DESIGN §8.1 ST-3, ST-11) through the caller's signal, not by a shorter fixed cap.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TwinClient } from "../src/twin.ts";

let server: Server;
let base = "";
let dropped = 0;
const body = { clipId: "c1", scenarioId: "s1", sources: [{ ssePath: "sam/c1/fault.sse", conceptIdx: 0 }] };

beforeAll(async () => {
  // `/<ms>/sam/ingest` answers after <ms>, the way a long decode holds the request open.
  server = createServer((req, res) => {
    const delay = Number((req.url ?? "/0").split("/")[1]) || 0;
    req.resume();
    const timer = setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ clipId: "c1", csmkPath: "masks/c1.csmk", records: 3, flags: 0, objects: {}, usage: {}, warnings: [] }));
    }, delay);
    res.on("close", () => {
      if (!res.writableFinished) { dropped += 1; clearTimeout(timer); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("TwinClient.samIngest", () => {
  it("returns the ingest result while the stage is still open", async () => {
    const stage = new AbortController();
    const res = await new TwinClient(`${base}/300`).samIngest(body, stage.signal);
    expect(res.csmkPath).toBe("masks/c1.csmk");
  });

  it("cancels the request when the stage deadline fires", async () => {
    const stage = new AbortController();
    const before = dropped;
    const t0 = Date.now();
    setTimeout(() => stage.abort(new Error("PERCEIVING_POST exceeded 60 s")), 100);
    await expect(new TwinClient(`${base}/5000`).samIngest(body, stage.signal)).rejects.toMatchObject({ code: "TWIN_TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    await new Promise((r) => setTimeout(r, 100));
    expect(dropped).toBe(before + 1);
  });
});
