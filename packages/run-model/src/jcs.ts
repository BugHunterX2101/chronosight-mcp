// RFC 8785 canonical JSON. Hashes that cross the TS/Python boundary
// (patchSpecHash, approval tokens) are taken over these bytes; the twin uses
// rfc8785.dumps, and test/vectors/jcs.json keeps the two in agreement.

import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

function assertFinite(v: unknown, path: string): void {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError(`JCS: non-finite number at ${path}`);
  } else if (Array.isArray(v)) {
    v.forEach((x, i) => assertFinite(x, `${path}[${i}]`));
  } else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) assertFinite(x, `${path}.${k}`);
  }
}

export function jcs(value: unknown): string {
  assertFinite(value, "$");
  const out = canonicalize(value);
  if (out === undefined) throw new TypeError("JCS: value has no JSON representation");
  return out;
}

export function jcsBytes(value: unknown): Buffer {
  return Buffer.from(jcs(value), "utf8");
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** "sha256:<hex>" over the canonical bytes of value. */
export function sha256Tag(value: unknown): string {
  return `sha256:${sha256Hex(jcsBytes(value))}`;
}

export const patchSpecHash = sha256Tag;
