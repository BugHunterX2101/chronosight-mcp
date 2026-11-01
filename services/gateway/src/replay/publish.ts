import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { Manifest } from "./record.ts";
import { verifyBundle } from "./record.ts";

export class ReplayPublishError extends Error {}

export interface ReplayPublisherOptions {
  bucketUrl: string;
  storageKey: string;
  fetchImpl?: typeof fetch;
}

export interface PublishedReplay {
  baseUrl: string;
  objects: number;
  bytes: number;
}

const MIME: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".html": "text/html; charset=utf-8",
  ".mp4": "video/mp4",
  ".csmk": "application/octet-stream",
  ".idx": "application/octet-stream",
  ".sse": "text/event-stream",
  ".diff": "text/plain; charset=utf-8",
};

const files = async (root: string, dir = root): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(root, path));
    else if (entry.isFile()) out.push(relative(root, path).split("\\").join("/"));
  }
  return out.sort();
};

const objectUrl = (base: string, path: string): string => `${base.replace(/\/+$/, "")}/${path.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Publishes an already verified PUBLIC replay as immutable objects.
 * The bucket URL is expected to accept authenticated PUTs and to preserve
 * the requested object path. Existing objects are accepted only when the
 * provider reports the immutable-object precondition response.
 */
export async function publishReplay(dir: string, manifest: Manifest, options: ReplayPublisherOptions): Promise<PublishedReplay> {
  const root = resolve(dir);
  const verification = verifyBundle(root);
  if (!verification.ok) throw new ReplayPublishError(`refusing unverified bundle ${verification.path}: ${verification.reason}`);
  if (manifest.dataClass !== "PUBLIC") throw new ReplayPublishError("only PUBLIC replay bundles may be published");
  if (!manifest.runId || !manifest.files.length) throw new ReplayPublishError("replay manifest has no publishable files");

  const actual = await files(root);
  const expected = new Set([...manifest.files.map((f) => f.path), "manifest.json"]);
  if (actual.some((path) => !expected.has(path)) || actual.length !== expected.size) {
    throw new ReplayPublishError("bundle contents changed after manifest verification");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.bucketUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(baseUrl)) throw new ReplayPublishError("STORAGE_BUCKET_URL must be an http(s) URL");
  const headers = { authorization: `Bearer ${options.storageKey}` };
  let bytes = 0;
  let objects = 0;

  for (const path of actual) {
    const full = join(root, path);
    const info = await stat(full);
    const response = await fetchImpl(objectUrl(baseUrl, `${manifest.runId}/${path}`), {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": MIME[extname(path).toLowerCase()] ?? "application/octet-stream",
        "cache-control": path === "manifest.json" ? "public, max-age=60" : "public, max-age=31536000, immutable",
        "if-none-match": "*",
        "content-length": String(info.size),
      },
      body: await readFile(full),
    });
    if (!response.ok && response.status !== 409 && response.status !== 412) {
      throw new ReplayPublishError(`storage PUT failed for ${path}: HTTP ${response.status}`);
    }
    bytes += info.size;
    objects++;
  }
  return { baseUrl, objects, bytes };
}

export function replayObjectPrefix(bucketUrl: string, manifest: Manifest): string {
  return objectUrl(bucketUrl.replace(/\/+$/, ""), `${manifest.runId}/`);
}
