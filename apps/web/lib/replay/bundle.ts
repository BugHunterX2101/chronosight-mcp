// Replay bundle loader (DESIGN §24.3). Every file the player uses is checked against the sha256 in
// manifest.json before it is used; one flipped byte surfaces as an IntegrityError (TH-3).
import { EnvelopeSchema, type Envelope } from "@chronosight/run-model/browser";

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  bundleVersion: 1;
  runId: string;
  scenarioId: string;
  recordedAt: string;
  appCommit: string;
  models: string[];
  dataClass: "PUBLIC";
  durationMs: number;
  files: ManifestFile[];
}

export interface Scenario {
  id: string;
  title: string;
  concepts: { slug: string; role: string }[];
}

export class BundleError extends Error {}

export class IntegrityError extends Error {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  constructor(path: string, expected: string, actual: string) {
    super(`${path} does not match its recorded sha256`);
    this.path = path;
    this.expected = expected;
    this.actual = actual;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseManifest(raw: unknown): Manifest {
  if (!isObj(raw)) throw new BundleError("manifest.json is not an object");
  const { bundleVersion, runId, scenarioId, recordedAt, appCommit, models, dataClass, durationMs, files } = raw;
  if (bundleVersion !== 1) throw new BundleError(`unsupported bundleVersion ${String(bundleVersion)}`);
  if (dataClass !== "PUBLIC") throw new BundleError("only PUBLIC bundles can be replayed");
  if (typeof runId !== "string" || typeof scenarioId !== "string" || typeof recordedAt !== "string" || typeof appCommit !== "string") {
    throw new BundleError("manifest.json is missing identity fields");
  }
  if (!Array.isArray(models) || !models.every((m) => typeof m === "string")) throw new BundleError("manifest.json has bad models");
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) throw new BundleError("manifest.json has a bad durationMs");
  if (!Array.isArray(files)) throw new BundleError("manifest.json has no file list");
  const entries: ManifestFile[] = files.map((f: unknown) => {
    if (!isObj(f) || typeof f.path !== "string" || typeof f.sha256 !== "string" || typeof f.bytes !== "number") {
      throw new BundleError("manifest.json has a malformed file entry");
    }
    // A manifest must not be able to point the player outside its own bundle directory.
    if (f.path.startsWith("/") || f.path.split("/").some((s) => s === ".." || s === "." || s === "")) {
      throw new BundleError(`manifest path ${f.path} escapes the bundle`);
    }
    return { path: f.path, sha256: f.sha256, bytes: f.bytes };
  });
  return { bundleVersion: 1, runId, scenarioId, recordedAt, appCommit, models: models as string[], dataClass: "PUBLIC", durationMs, files: entries };
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new BundleError("SubtleCrypto is unavailable; replays need a secure context (https or localhost)");
  const digest = new Uint8Array(await subtle.digest("SHA-256", buf));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Bundle {
  readonly base: string;
  readonly manifest: Manifest;
  private readonly fetcher: typeof fetch;
  private readonly entries = new Map<string, ManifestFile>();
  private readonly cache = new Map<string, Promise<ArrayBuffer>>();
  private readonly blobUrls: string[] = [];
  private readonly checked: string[] = [];

  /** Paths that have passed their sha256 check so far. */
  get verified(): readonly string[] {
    return this.checked;
  }

  constructor(base: string, manifest: Manifest, fetcher: typeof fetch) {
    this.base = base;
    this.manifest = manifest;
    this.fetcher = fetcher;
    for (const f of manifest.files) this.entries.set(f.path, f);
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** The URL of a file for plain links (the .sse tees, diff and report); not integrity-checked. */
  link(path: string): string {
    return `${this.base}/${path}`;
  }

  /** The verified bytes of one file, fetched once. */
  bytes(path: string): Promise<ArrayBuffer> {
    const hit = this.cache.get(path);
    if (hit !== undefined) return hit;
    const entry = this.entries.get(path);
    if (entry === undefined) return Promise.reject(new BundleError(`${path} is not in the manifest`));
    const p = this.load(entry);
    this.cache.set(path, p);
    return p;
  }

  private async load(entry: ManifestFile): Promise<ArrayBuffer> {
    // Called as a bare function: `fetch` throws "Illegal invocation" with any `this` but the window.
    const fetcher = this.fetcher;
    const res = await fetcher(this.link(entry.path));
    if (!res.ok) throw new BundleError(`${entry.path}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const actual = await sha256Hex(buf);
    if (buf.byteLength !== entry.bytes || actual !== entry.sha256) throw new IntegrityError(entry.path, entry.sha256, actual);
    this.checked.push(entry.path);
    return buf;
  }

  async text(path: string): Promise<string> {
    return new TextDecoder().decode(await this.bytes(path));
  }

  async json(path: string): Promise<unknown> {
    return JSON.parse(await this.text(path));
  }

  /** A blob: URL for a verified file, so the <video> only ever plays bytes that passed the check. */
  async blobUrl(path: string, type: string): Promise<string> {
    const url = URL.createObjectURL(new Blob([await this.bytes(path)], { type }));
    this.blobUrls.push(url);
    return url;
  }

  dispose(): void {
    for (const u of this.blobUrls.splice(0)) URL.revokeObjectURL(u);
  }
}

export function parseEvents(text: string): Envelope[] {
  const out: Envelope[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const e = EnvelopeSchema.parse(JSON.parse(line)) as Envelope;
    const prev = out[out.length - 1];
    if (prev !== undefined && e.seq <= prev.seq) throw new BundleError(`events.jsonl seq ${e.seq} does not follow ${prev.seq}`);
    out.push(e);
  }
  if (out.length === 0) throw new BundleError("events.jsonl is empty");
  return out;
}

function parseScenario(raw: unknown, fallbackId: string): Scenario {
  if (!isObj(raw) || typeof raw.title !== "string" || !Array.isArray(raw.concepts)) return { id: fallbackId, title: fallbackId, concepts: [] };
  const concepts = raw.concepts.flatMap((c: unknown) => (isObj(c) && typeof c.slug === "string" ? [{ slug: c.slug, role: String(c.role ?? "") }] : []));
  return { id: typeof raw.id === "string" ? raw.id : fallbackId, title: raw.title, concepts };
}

export interface OpenedBundle {
  bundle: Bundle;
  scenario: Scenario;
  events: Envelope[];
}

export async function openBundle(base: string, fetcher: typeof fetch = fetch): Promise<OpenedBundle> {
  const res = await fetcher(`${base}/manifest.json`);
  if (!res.ok) throw new BundleError(`manifest.json: HTTP ${res.status}`);
  const manifest = parseManifest(await res.json());
  const bundle = new Bundle(base, manifest, fetcher);
  const [events, scenario] = await Promise.all([
    bundle.text("events.jsonl").then(parseEvents),
    bundle.has("scenario.json") ? bundle.json("scenario.json").then((r) => parseScenario(r, manifest.scenarioId)) : Promise.resolve(parseScenario(null, manifest.scenarioId)),
  ]);
  return { bundle, scenario, events };
}
