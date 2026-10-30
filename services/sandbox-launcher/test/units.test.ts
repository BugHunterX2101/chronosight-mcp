import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Demuxer } from "../src/docker.ts";
import { hostConfig, LaunchError, Launcher, type LauncherConfig } from "../src/launcher.ts";
import { configFromEnv, museServeArgv, redactor } from "../src/server.ts";
import { tar } from "../src/tar.ts";

const cfg: LauncherConfig = {
  image: "img",
  egressProxyUrl: "http://egress-proxy:3128",
  metaApiKey: "k",
  scenariosDir: fileURLToPath(new URL("../../twin/twin/scenarios", import.meta.url)),
  network: "sbx",
  museServe: museServeArgv,
};

const spec = {
  targetFiles: ["controller.py", "params.py"],
  interface: "step(state, dt) -> Command",
  objectives: { overshootPctMax: 10, settleSecMax: 2, sseMax: 0.01 },
  bounds: { kp: [0, 10] },
  approachHints: [],
};
const good = {
  kind: "test",
  candidateId: "c1",
  scenario: "s1",
  dataClass: "PUBLIC",
  patchSpec: spec,
  patchSpecHash: "sha256:" + "0".repeat(64),
  files: { "controller.py": "x = 1\n" },
};

/** A Docker stand-in that records calls. */
function fakeDocker() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  return {
    calls,
    call: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      return { status: 200, body: { Id: "a".repeat(64) } };
    },
    putArchive: async () => undefined,
    exec: async () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    execStream: async () => {
      throw new Error("unused");
    },
  };
}

describe("tar", () => {
  it("writes valid ustar headers with the fixed owner", () => {
    const b = tar([{ name: "params.py", data: "kp = 1.0\n" }], { uid: 10001, gid: 10001 }, 0);
    expect(b.subarray(0, 9).toString("ascii")).toBe("params.py");
    expect(b.subarray(257, 262).toString("ascii")).toBe("ustar");
    expect(parseInt(b.subarray(108, 115).toString("ascii"), 8)).toBe(10001);
    expect(parseInt(b.subarray(124, 135).toString("ascii"), 8)).toBe(9);
    const h = Buffer.from(b.subarray(0, 512));
    const stored = parseInt(h.subarray(148, 154).toString("ascii"), 8);
    h.fill(0x20, 148, 156);
    expect([...h].reduce((a, x) => a + x, 0)).toBe(stored);
    expect(b.subarray(512, 521).toString("utf8")).toBe("kp = 1.0\n");
    // header, one data block, two end blocks
    expect(b.length).toBe(512 * 4);
  });

  it.each(["../x", "a/b", ".git", "", "x".repeat(101), "a b"])("refuses the name %j", (name) => {
    expect(() => tar([{ name, data: "" }], { uid: 1, gid: 1 })).toThrow(/bad file name/);
  });
});

describe("Demuxer", () => {
  const frame = (stream: number, s: string) => {
    const p = Buffer.from(s);
    const h = Buffer.alloc(8);
    h[0] = stream;
    h.writeUInt32BE(p.length, 4);
    return Buffer.concat([h, p]);
  };

  it("routes frames by stream and reassembles frames split across chunks", () => {
    const got: [number, string][] = [];
    const d = new Demuxer((s, c) => got.push([s, c.toString()]));
    const all = Buffer.concat([frame(1, "out"), frame(2, "err"), frame(1, "more")]);
    for (let i = 0; i < all.length; i += 3) d.push(all.subarray(i, i + 3));
    expect(got).toEqual([[1, "out"], [2, "err"], [1, "more"]]);
  });
});

describe("hostConfig (DESIGN §19)", () => {
  it("fixes every flag and gives test containers no network", () => {
    const t = hostConfig("test", "vol", "sbx");
    expect(t).toMatchObject({
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NanoCpus: 2e9,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      PidsLimit: 256,
      NetworkMode: "none",
      Init: true,
    });
    expect(t.Mounts).toEqual([{ Type: "volume", Source: "vol", Target: "/workspace" }]);
    expect(t).not.toHaveProperty("Binds");
    expect(t).not.toHaveProperty("Privileged");
    expect(hostConfig("synthesis", "vol", "sbx").NetworkMode).toBe("sbx");
  });
});

describe("launch validation (§15.2 #11)", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["an unknown field", { ...good, image: "evil" }],
    ["a bad candidate id", { ...good, candidateId: "c4" }],
    ["a candidate id with a path", { ...good, candidateId: "../c1" }],
    ["a file outside targetFiles", { ...good, files: { "abi.py": "x" } }],
    ["a path as a file name", { ...good, files: { "../controller.py": "x" } }],
    ["no files", { ...good, files: {} }],
    ["a target the scenario does not have", { ...good, patchSpec: { ...spec, targetFiles: ["controller.py", "plant.py"] } }],
    ["an unknown scenario", { ...good, scenario: "s99" }],
    ["an unknown kind", { ...good, kind: "shell" }],
    ["a missing data class", { ...good, dataClass: undefined }],
  ];
  it.each(cases)("rejects %s before touching Docker", async (_, body) => {
    const d = fakeDocker();
    const l = new Launcher(cfg, d as never);
    await expect(l.launch(body)).rejects.toBeInstanceOf(LaunchError);
    expect(d.calls).toEqual([]);
  });

  it("refuses synthesis without a key", async () => {
    const d = fakeDocker();
    const l = new Launcher({ ...cfg, metaApiKey: null }, d as never);
    await expect(l.launch({ ...good, kind: "synthesis" })).rejects.toThrow(/META_API_KEY/);
    expect(d.calls).toEqual([]);
  });

  it("gives the key and proxy to synthesis containers only", async () => {
    const d = fakeDocker();
    const l = new Launcher(cfg, d as never);
    await l.launch(good);
    await l.launch({ ...good, kind: "synthesis", candidateId: "c2" });
    const creates = d.calls.filter((c) => c.path.startsWith("/containers/create")).map((c) => c.body as { Env: string[]; Cmd: string[]; User: string; Image: string });
    expect(creates[0]).toMatchObject({ Env: [], Cmd: ["sleep", "120"], User: "10001:10001", Image: "img" });
    expect(creates[1]).toMatchObject({
      Env: ["HTTPS_PROXY=http://egress-proxy:3128", "https_proxy=http://egress-proxy:3128", "META_API_KEY=k"],
      Cmd: ["sleep", "infinity"],
    });
    await l.close();
  });

  it("rejects malformed and unknown container ids", async () => {
    const l = new Launcher(cfg, fakeDocker() as never);
    await expect(l.runTests("abc")).rejects.toThrow(/bad container id/);
    await expect(l.destroy("../x")).rejects.toThrow(/bad container id/);
    await expect(l.collect("f".repeat(64))).rejects.toThrow(/no such sandbox/);
    await expect(l.destroy("f".repeat(64))).resolves.toBeUndefined();
  });
});

describe("server config", () => {
  it("pins model and contributor mode by data class", () => {
    expect(museServeArgv("PUBLIC")).toEqual([
      "muse", "serve", "--provider", "meta", "--model", "muse-spark-1.3-contributor",
      "--contributor-mode", "on", "--sandbox-network", "restricted", "--disable-request-user-input",
    ]);
    const conf = museServeArgv("CONFIDENTIAL");
    expect(conf[conf.indexOf("--model") + 1]).toBe("muse-spark-1.3");
    expect(conf[conf.indexOf("--contributor-mode") + 1]).toBe("off");
  });

  it("needs an image and defaults the rest", () => {
    expect(() => configFromEnv({})).toThrow(/SANDBOX_IMAGE/);
    const c = configFromEnv({ SANDBOX_IMAGE: "img@sha256:x", META_API_KEY: " k " });
    expect(c).toMatchObject({ image: "img@sha256:x", egressProxyUrl: "http://egress-proxy:3128", metaApiKey: "k", network: "sbx" });
  });

  it("redacts the key everywhere it appears", () => {
    expect(redactor("s3cret")("a s3cret b s3cret")).toBe("a [REDACTED] b [REDACTED]");
    expect(redactor(null)("s3cret")).toBe("s3cret");
  });
});
