// Sandbox hardening assertions (TECHNICAL §15.2 #1–10; #11 is in units.test.ts). Each item
// is checked on containers the launcher itself creates, by inspection and by trying to break
// it. Needs a Docker daemon and the sandbox image; skipped when either is missing.

import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Docker } from "../src/docker.ts";
import { Launcher, type LauncherConfig } from "../src/launcher.ts";
import { museServeArgv } from "../src/server.ts";

const IMAGE = process.env.SANDBOX_IMAGE?.trim() || "chronosight-sandbox:dev";
const KEY = "hardening-suite-not-a-real-key";
const docker = new Docker();

async function ready(): Promise<boolean> {
  try {
    await docker.call("GET", "/_ping");
    return (await docker.call("GET", `/images/${encodeURIComponent(IMAGE)}/json`, undefined, [404])).status === 200;
  } catch {
    return false;
  }
}
const live = await ready();

const cfg: LauncherConfig = {
  image: IMAGE,
  egressProxyUrl: "http://egress-proxy:3128",
  metaApiKey: KEY,
  scenariosDir: fileURLToPath(new URL("../../twin/twin/scenarios", import.meta.url)),
  network: process.env.SANDBOX_NETWORK?.trim() || "sbx",
  museServe: museServeArgv,
};

const request = (kind: "synthesis" | "test", candidateId: string) => ({
  kind,
  candidateId,
  scenario: "s1",
  dataClass: "PUBLIC",
  patchSpec: {
    targetFiles: ["controller.py", "params.py"],
    interface: "step(state, dt) -> Command",
    objectives: { overshootPctMax: 10, settleSecMax: 2, sseMax: 0.01 },
    bounds: {},
    approachHints: [],
  },
  patchSpecHash: "sha256:" + "0".repeat(64),
  files: { "params.py": "KP = 1.0\n" },
});

interface Inspect {
  Config: { User: string; Env: string[] };
  HostConfig: Record<string, unknown>;
  Mounts: { Type: string; Destination: string }[];
}

describe.skipIf(!live)("sandbox hardening (§15.2)", () => {
  const launcher = new Launcher(cfg, docker);
  let syn = "";
  let tst = "";
  const sh = async (id: string, script: string) => {
    const r = await docker.exec(id, ["sh", "-c", script]);
    return { code: r.exitCode, out: r.stdout.toString("utf8").trim(), err: r.stderr.toString("utf8").trim() };
  };
  const inspect = async (id: string) => (await docker.call<Inspect>("GET", `/containers/${id}/json`)).body;

  beforeAll(async () => {
    syn = (await launcher.launch(request("synthesis", "c1"))).containerId;
    tst = (await launcher.launch(request("test", "c2"))).containerId;
  }, 60_000);
  afterAll(() => launcher.close(), 60_000);

  it("#1 root file system is read-only", async () => {
    for (const id of [syn, tst]) {
      expect((await inspect(id)).HostConfig.ReadonlyRootfs).toBe(true);
      expect((await sh(id, "touch /usr/x")).code).not.toBe(0);
      expect((await sh(id, "touch /etc/x")).code).not.toBe(0);
    }
  });

  it("#2 runs as UID and GID 10001", async () => {
    for (const id of [syn, tst]) expect((await sh(id, "echo $(id -u):$(id -g)")).out).toBe("10001:10001");
  });

  it("#3 has no capabilities and no-new-privileges", async () => {
    for (const id of [syn, tst]) {
      const h = (await inspect(id)).HostConfig;
      expect(h.CapDrop).toEqual(["ALL"]);
      expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
      expect(h.Privileged).toBe(false);
      const s = (await sh(id, "grep -E '^(CapEff|CapBnd|NoNewPrivs)' /proc/self/status")).out;
      expect(s).toMatch(/CapEff:\s+0{16}/);
      expect(s).toMatch(/CapBnd:\s+0{16}/);
      expect(s).toMatch(/NoNewPrivs:\s+1/);
    }
  });

  it("#4 /tmp is a 64 MB noexec tmpfs", async () => {
    const m = (await sh(tst, "grep ' /tmp ' /proc/mounts")).out;
    expect(m).toMatch(/^tmpfs \/tmp tmpfs /);
    expect(m).toMatch(/noexec/);
    expect(m).toMatch(/size=65536k/);
    const run = await sh(tst, "cp /bin/true /tmp/t && chmod +x /tmp/t && /tmp/t");
    expect(run.code).not.toBe(0);
    expect(run.err).toMatch(/Permission denied/);
  });

  it("#5 CPU, memory, swap and PID limits hold", async () => {
    for (const id of [syn, tst]) {
      expect((await inspect(id)).HostConfig).toMatchObject({ NanoCpus: 2e9, Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, PidsLimit: 256 });
    }
    const bomb = await sh(
      tst,
      `python -c "
import subprocess
ps = []
try:
    for _ in range(400):
        ps.append(subprocess.Popen(['sleep', '30']))
    print('unbounded', len(ps))
except OSError:
    print('blocked', len(ps))
for p in ps:
    p.kill()
"`,
    );
    const [verdict, n] = bomb.out.split(" ");
    expect(verdict).toBe("blocked");
    expect(Number(n)).toBeLessThan(256);
  }, 60_000);

  it("#6 only the proxy is reachable, and it only lets api.meta.ai:443 through", async () => {
    // the test container has no network at all
    expect((await sh(tst, "ls /sys/class/net")).out).toBe("lo");
    expect((await sh(tst, "curl -sS --max-time 5 https://1.1.1.1/")).code).not.toBe(0);

    // synthesis reaches nothing directly: not the internet, the host or a sibling service
    for (const url of ["https://1.1.1.1/", "http://host.docker.internal:8090/healthz", "http://gateway:8080/healthz", "http://twin:8090/healthz"]) {
      expect((await sh(syn, `curl -sS --noproxy '*' --max-time 5 ${url}`)).code, url).not.toBe(0);
    }
    if ((await sh(syn, "getent hosts egress-proxy")).code !== 0) return; // proxy not running: the direct checks above still hold
    const connect = async (target: string) => (await sh(syn, `curl -s -o /dev/null -w '%{http_connect}' --max-time 10 -x http://egress-proxy:3128 ${target}`)).out;
    expect(await connect("https://example.com/")).toBe("403");
    expect(await connect("https://api.meta.ai:8443/")).toBe("403");
    expect(await connect("https://twin:8090/")).toBe("403");
    expect((await sh(syn, "curl -s -o /dev/null -w '%{http_code}' --max-time 10 -x http://egress-proxy:3128 http://api.meta.ai/")).out).toBe("403");
    expect(await connect("https://api.meta.ai/")).not.toBe("403");
  }, 120_000);

  it("#7 no docker.sock and no mount but the workspace volume", async () => {
    for (const id of [syn, tst]) {
      const i = await inspect(id);
      expect(i.HostConfig.Binds ?? null).toBeNull();
      expect(i.Mounts.map((m) => [m.Type, m.Destination])).toEqual([["volume", "/workspace"]]);
      expect((await sh(id, "test -e /var/run/docker.sock || test -e /run/docker.sock")).code).not.toBe(0);
    }
  });

  it("#8 tests/ and the harness are read-only in the test container", async () => {
    expect((await sh(tst, "touch tests/x")).code).not.toBe(0);
    expect((await sh(tst, "echo 'assert False' >> tests/test_step_response.py")).code).not.toBe(0);
    expect((await sh(tst, "touch sim_harness/x")).code).not.toBe(0);
    expect((await sh(tst, "touch /opt/chronosight/s1/tests/x")).code).not.toBe(0);
  });

  it("#9 the test container has no Meta key; synthesis has it", async () => {
    expect((await inspect(tst)).Config.Env.some((e) => e.includes(KEY) || e.startsWith("META_API_KEY="))).toBe(false);
    expect((await sh(tst, "env")).out).not.toContain(KEY);
    expect((await inspect(syn)).Config.Env).toContain(`META_API_KEY=${KEY}`);
  });

  it("#10 containers die at the hard limit", async () => {
    const short = new Launcher({ ...cfg, hardLimitMs: 4_000 }, docker);
    const { containerId } = await short.launch(request("test", "c3"));
    const sleeper = docker.exec(containerId, ["sleep", "300"]).catch(() => null);
    await new Promise((r) => setTimeout(r, 7_000));
    expect((await docker.call("GET", `/containers/${containerId}/json`, undefined, [404])).status).toBe(404);
    await sleeper;
    expect(short.list()).toEqual([]);
  }, 30_000);
});
