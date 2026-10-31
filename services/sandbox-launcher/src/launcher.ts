// Sandbox launcher (DL-22, TECHNICAL §5.6). The only holder of the Docker socket. Its
// operations take nothing free-form: the image, every DESIGN §19 flag, the mounts and
// the environment are fixed here, and callers pass only the fields below.
//
// Besides §5.6's launch, attach, runTests and destroy there is `collect`, which reads a
// synthesis workspace back after its turn (target files, changed paths, git diff). The
// gateway has no other way to get the candidate's edits for DESIGN §18.9 steps 1 to 3.

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { PatchSpec } from "@chronosight/run-model";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Docker, DockerError } from "./docker.ts";
import { tar } from "./tar.ts";

export const LABEL = "dev.chronosight.sandbox";
export const UID = 10001;
export const HARD_LIMIT_MS = 120_000;
/** A warm synthesis container waits at most this long for its session (ST-7 expires at 15 min). */
export const WARM_LIMIT_MS = 16 * 60_000;
const WORKSPACE = "/workspace";
/** the read-only S1 harness baked into the image (sandbox/Dockerfile) */
const HARNESS = "/opt/chronosight/s1";
const MAX_FILE_BYTES = 256 * 1024;
const TAIL_BYTES = 4096;

export const LaunchRequest = z.strictObject({
  kind: z.enum(["synthesis", "test"]),
  candidateId: z.string().regex(/^c[1-3]$/),
  scenario: z.string().regex(/^s[0-9]{1,3}$/),
  /** picks the model tier and contributor mode of `muse serve` (DESIGN §18.11) */
  dataClass: z.enum(["PUBLIC", "CONFIDENTIAL"]),
  patchSpec: PatchSpec,
  patchSpecHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  /** full contents of target files only (§15.2 #11) */
  files: z.record(z.string(), z.string().max(MAX_FILE_BYTES)),
});
export type LaunchRequest = z.infer<typeof LaunchRequest>;

export const ContainerId = z.string().regex(/^[0-9a-f]{64}$/);

export interface Metrics {
  overshootPct: number | null;
  settleSec: number | null;
  sse: number | null;
  error: string | null;
}

export interface TestResult {
  exitCode: number;
  junitXml: string;
  stdoutTail: string;
  metrics: Metrics | null;
}

export class LaunchError extends Error {
  readonly code: "BAD_REQUEST" | "NOT_FOUND" | "WRONG_KIND";
  constructor(code: LaunchError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export interface LauncherConfig {
  image: string;
  /** HTTPS_PROXY for synthesis containers (EGRESS_PROXY_URL) */
  egressProxyUrl: string;
  /** the Meta key, read by the launcher itself; only synthesis containers receive it */
  metaApiKey: string | null;
  scenariosDir: string;
  network: string;
  /** the hard limit; only the hardening suite shortens it */
  hardLimitMs?: number;
  /** `muse serve` argv run by attach (DESIGN §18.11) */
  museServe: (dataClass: LaunchRequest["dataClass"]) => readonly string[];
}

export interface Collected {
  /** current contents of each target file that exists */
  files: Record<string, string>;
  /** every workspace path git sees as changed, added or deleted since the baseline commit */
  changedPaths: string[];
  /** `git diff` of the target files against the baseline */
  diff: string;
}

interface Sandbox {
  kind: LaunchRequest["kind"];
  candidateId: string;
  dataClass: LaunchRequest["dataClass"];
  targetFiles: readonly string[];
  volume: string;
  timer: NodeJS.Timeout;
  attached: boolean;
}

/** Docker's default seccomp profile, verbatim from moby/profiles seccomp/default.json @ 6fe7deb. */
export const SECCOMP_DEFAULT_PATH = fileURLToPath(new URL("../../../sandbox/policies/seccomp-default.json", import.meta.url));

/**
 * Muse Code runs every agent shell command in bubblewrap, which needs user, network and
 * mount namespaces and pivot_root. Docker's default profile allows those only with
 * CAP_SYS_ADMIN, which §19 drops, so the agent's `pytest` could never start (SP-5, D-10).
 * Synthesis containers get the default plus exactly these syscalls; test containers keep
 * the default, since their pytest runs through `docker exec` without bubblewrap.
 */
export const BWRAP_SYSCALLS = ["clone", "mount", "pivot_root", "setns", "umount2", "unshare"] as const;

export function synthesisSeccomp(defaultProfile: string): string {
  const p = JSON.parse(defaultProfile) as { syscalls: object[] };
  p.syscalls.push({ names: [...BWRAP_SYSCALLS], action: "SCMP_ACT_ALLOW" });
  return JSON.stringify(p);
}

/** The fixed host config (DESIGN §19). Exported for the hardening suite. */
export function hostConfig(kind: LaunchRequest["kind"], volume: string, network: string, seccomp: string) {
  return {
    ReadonlyRootfs: true,
    Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
    CapDrop: ["ALL"],
    SecurityOpt: kind === "synthesis" ? ["no-new-privileges:true", `seccomp=${seccomp}`] : ["no-new-privileges:true"],
    NanoCpus: 2_000_000_000,
    Memory: 2 * 1024 ** 3,
    MemorySwap: 2 * 1024 ** 3,
    PidsLimit: 256,
    // Test containers get no network at all (DESIGN §18.9); synthesis reaches only the proxy.
    NetworkMode: kind === "synthesis" ? network : "none",
    Mounts: [{ Type: "volume", Source: volume, Target: WORKSPACE }],
    Init: true,
  };
}

function tail(b: Buffer): string {
  return b.subarray(Math.max(0, b.length - TAIL_BYTES)).toString("utf8");
}

export class Launcher {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly targetFiles = new Map<string, readonly string[]>();

  private readonly cfg: LauncherConfig;
  private readonly docker: Docker;
  private readonly seccomp: string;

  constructor(cfg: LauncherConfig, docker = new Docker()) {
    this.cfg = cfg;
    this.docker = docker;
    this.seccomp = synthesisSeccomp(readFileSync(SECCOMP_DEFAULT_PATH, "utf8"));
  }

  private get hardLimitMs(): number {
    return this.cfg.hardLimitMs ?? HARD_LIMIT_MS;
  }

  private scenarioTargets(scenario: string): readonly string[] {
    let t = this.targetFiles.get(scenario);
    if (!t) {
      let doc: { targetFiles?: unknown };
      try {
        doc = parseYaml(readFileSync(join(this.cfg.scenariosDir, scenario, "scenario.yaml"), "utf8")) as { targetFiles?: unknown };
      } catch {
        throw new LaunchError("BAD_REQUEST", `unknown scenario ${scenario}`);
      }
      t = z.array(z.string()).parse(doc.targetFiles);
      this.targetFiles.set(scenario, t);
    }
    return t;
  }

  /** Removes every container and volume labelled as ours (run on start). */
  async sweep(): Promise<number> {
    const filter = encodeURIComponent(JSON.stringify({ label: [LABEL] }));
    const { body: cs } = await this.docker.call<{ Id: string }[]>("GET", `/containers/json?all=1&filters=${filter}`);
    for (const c of cs) await this.docker.call("DELETE", `/containers/${c.Id}?force=1`, undefined, [404, 409]);
    const { body: vs } = await this.docker.call<{ Volumes: { Name: string }[] | null }>("GET", `/volumes?filters=${filter}`);
    for (const v of vs.Volumes ?? []) await this.docker.call("DELETE", `/volumes/${v.Name}?force=1`, undefined, [404, 409]);
    return cs.length;
  }

  async launch(input: unknown): Promise<{ containerId: string; workspaceVolume: string }> {
    const parsed = LaunchRequest.safeParse(input);
    if (!parsed.success) throw new LaunchError("BAD_REQUEST", z.prettifyError(parsed.error));
    const req = parsed.data;
    const allowed = this.scenarioTargets(req.scenario);
    for (const f of req.patchSpec.targetFiles) {
      if (!allowed.includes(f)) throw new LaunchError("BAD_REQUEST", `patchSpec.targetFiles: ${f} is not a target file of ${req.scenario}`);
    }
    const names = Object.keys(req.files);
    if (names.length === 0) throw new LaunchError("BAD_REQUEST", "files: at least one target file is required");
    for (const f of names) {
      if (!(req.patchSpec.targetFiles as readonly string[]).includes(f)) throw new LaunchError("BAD_REQUEST", `files: ${f} is not in patchSpec.targetFiles`);
    }
    if (req.kind === "synthesis" && !this.cfg.metaApiKey) throw new LaunchError("BAD_REQUEST", "synthesis needs META_API_KEY in the launcher");

    const suffix = randomBytes(4).toString("hex");
    const volume = `cs-${req.kind}-${req.candidateId}-${suffix}`;
    const labels = { [LABEL]: "1", [`${LABEL}.kind`]: req.kind, [`${LABEL}.candidate`]: req.candidateId };
    await this.docker.call("POST", "/volumes/create", { Name: volume, Labels: labels });

    const env = req.kind === "synthesis"
      ? [`HTTPS_PROXY=${this.cfg.egressProxyUrl}`, `https_proxy=${this.cfg.egressProxyUrl}`, `META_API_KEY=${this.cfg.metaApiKey}`]
      : [];
    let containerId: string;
    try {
      const { body } = await this.docker.call<{ Id: string }>("POST", `/containers/create?name=${volume}`, {
        Image: this.cfg.image,
        User: `${UID}:${UID}`,
        WorkingDir: WORKSPACE,
        Env: env,
        // PID 1 only keeps the container alive; test containers also end themselves.
        Cmd: req.kind === "test" ? ["sleep", String(Math.ceil(this.hardLimitMs / 1000))] : ["sleep", "infinity"],
        Labels: labels,
        HostConfig: hostConfig(req.kind, volume, this.cfg.network, this.seccomp),
      });
      containerId = body.Id;
    } catch (e) {
      await this.docker.call("DELETE", `/volumes/${volume}?force=1`, undefined, [404, 409]);
      throw e;
    }

    const limit = req.kind === "test" ? this.hardLimitMs : WARM_LIMIT_MS;
    const sandbox: Sandbox = {
      kind: req.kind,
      candidateId: req.candidateId,
      dataClass: req.dataClass,
      targetFiles: req.patchSpec.targetFiles,
      volume,
      timer: setTimeout(() => void this.destroy(containerId), limit),
      attached: false,
    };
    this.sandboxes.set(containerId, sandbox);
    try {
      await this.docker.call("POST", `/containers/${containerId}/start`);
      const spec = JSON.stringify({ ...req.patchSpec, patchSpecHash: req.patchSpecHash }, null, 2) + "\n";
      const entries = [...names.map((n) => ({ name: n, data: req.files[n]! })), { name: "PATCH_SPEC.json", data: spec }];
      await this.docker.putArchive(containerId, WORKSPACE, tar(entries, { uid: UID, gid: UID }));
      if (req.kind === "synthesis") await this.gitInit(containerId);
    } catch (e) {
      await this.destroy(containerId);
      throw e;
    }
    return { containerId, workspaceVolume: volume };
  }

  /** The workspace starts as one commit, so the diff (DESIGN §18.9) holds only the agent's edits. */
  private async gitInit(id: string): Promise<void> {
    for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "baseline"]]) await this.git(id, args);
  }

  private async git(id: string, args: readonly string[]): Promise<Buffer> {
    const r = await this.docker.exec(id, ["git", "-c", "user.name=chronosight", "-c", "user.email=sandbox@chronosight.invalid", ...args], { workingDir: WORKSPACE });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${tail(r.stderr)}`);
    return r.stdout;
  }

  async collect(id: string): Promise<Collected> {
    const s = this.get(id, "synthesis");
    // -z output is "XY path\0", with a second NUL-terminated path after a rename
    // collect can run while the turn is live; --no-optional-locks keeps status from taking index.lock.
    const status = (await this.git(id, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"])).toString("utf8");
    const changedPaths = status.split("\0").filter((e) => e.length > 3).map((e) => e.slice(3));
    const diff = (await this.git(id, ["diff", "--no-color", "--no-ext-diff", "--", ...s.targetFiles])).toString("utf8");
    const files: Record<string, string> = {};
    for (const f of s.targetFiles) {
      const r = await this.docker.exec(id, ["cat", "--", f], { workingDir: WORKSPACE });
      if (r.exitCode === 0) files[f] = r.stdout.toString("utf8");
    }
    return { files, changedPaths, diff };
  }

  private get(id: string, kind: LaunchRequest["kind"]): Sandbox {
    if (!ContainerId.safeParse(id).success) throw new LaunchError("BAD_REQUEST", "bad container id");
    const s = this.sandboxes.get(id);
    if (!s) throw new LaunchError("NOT_FOUND", "no such sandbox");
    if (s.kind !== kind) throw new LaunchError("WRONG_KIND", `not a ${kind} sandbox`);
    return s;
  }

  /**
   * Starts `muse serve` in a synthesis container and returns its stdio. The first attach
   * starts the 120 s hard limit; a later attach (crash recovery, DESIGN §18.6) keeps it.
   */
  async attach(id: string, onStderr: (chunk: Buffer) => void): Promise<Duplex> {
    const s = this.get(id, "synthesis");
    if (!s.attached) {
      s.attached = true;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => void this.destroy(id), this.hardLimitMs);
    }
    return this.docker.execStream(id, this.cfg.museServe(s.dataClass), onStderr);
  }

  /** The independent harness (DESIGN §18.9): pytest over the read-only tests, then the metrics. */
  async runTests(id: string): Promise<TestResult> {
    this.get(id, "test");
    // Absolute paths into the read-only image, never the workspace's links (TH-5).
    const py = await this.docker.exec(id, ["python", "-m", "pytest", "-q", `${HARNESS}/tests`, "--junitxml=/tmp/junit.xml"], { workingDir: WORKSPACE });
    const junit = await this.docker.exec(id, ["cat", "/tmp/junit.xml"]);
    const step = await this.docker.exec(id, ["python", `${HARNESS}/sim_harness/step.py`], { workingDir: WORKSPACE });
    let metrics: Metrics | null = null;
    if (step.exitCode === 0) {
      try {
        metrics = JSON.parse(step.stdout.toString("utf8").trim().split("\n").pop() ?? "") as Metrics;
      } catch {
        metrics = null;
      }
    }
    return {
      exitCode: py.exitCode,
      junitXml: junit.exitCode === 0 ? junit.stdout.toString("utf8") : "",
      stdoutTail: tail(Buffer.concat([py.stdout, py.stderr])),
      metrics,
    };
  }

  /** Idempotent: an unknown or already-removed container is not an error. */
  async destroy(id: string): Promise<void> {
    if (!ContainerId.safeParse(id).success) throw new LaunchError("BAD_REQUEST", "bad container id");
    const s = this.sandboxes.get(id);
    if (!s) return;
    this.sandboxes.delete(id);
    clearTimeout(s.timer);
    try {
      await this.docker.call("DELETE", `/containers/${id}?force=1`, undefined, [404, 409]);
    } finally {
      await this.docker.call("DELETE", `/volumes/${s.volume}?force=1`, undefined, [404, 409]).catch((e: unknown) => {
        if (!(e instanceof DockerError)) throw e;
      });
    }
  }

  /** For the hardening suite and logs. */
  list(): { containerId: string; kind: string; candidateId: string }[] {
    return [...this.sandboxes].map(([containerId, s]) => ({ containerId, kind: s.kind, candidateId: s.candidateId }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.sandboxes.keys()].map((id) => this.destroy(id)));
  }
}
