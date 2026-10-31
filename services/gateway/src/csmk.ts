// Reader for the .csmk mask container and its .csmk.idx sidecar (TECHNICAL §6.9, DESIGN §10).
// The Python writer is twin/metrics/csmk.py; the layouts must stay byte-identical.
// Records are 31 bytes plus a payload, so they are unaligned: everything goes through Buffer
// reads, never typed-array views over the file.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const MAGIC = "CSMK";
const IDX_MAGIC = "CSMI";
const VERSION = 1;
const HEADER_LEN = 20;
const RECORD_LEN = 31;
const IDX_HEADER_LEN = 10;
const IDX_ENTRY_LEN = 12;

export class CsmkError extends Error {}

export interface MaskRange {
  /** "<conceptIdx>:<objectId>"; omitted means every track. */
  track?: string;
  /** Inclusive frame bounds; omitted means open. */
  from?: number;
  to?: number;
}

const readAt = (fd: number, offset: number, length: number): Buffer => {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, offset + got);
    if (n === 0) throw new CsmkError("file ends inside a record");
    got += n;
  }
  return buf;
};

interface Index {
  frames: number[];
  offsets: number[];
}

function parseIndex(buf: Buffer): Index {
  if (buf.length < IDX_HEADER_LEN || buf.toString("latin1", 0, 4) !== IDX_MAGIC) throw new CsmkError("bad index magic");
  if (buf.readUInt16LE(4) !== VERSION) throw new CsmkError(`unknown index version ${buf.readUInt16LE(4)}`);
  const count = buf.readUInt32LE(6);
  if (buf.length !== IDX_HEADER_LEN + count * IDX_ENTRY_LEN) throw new CsmkError("index count does not match its length");
  const frames: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = IDX_HEADER_LEN + i * IDX_ENTRY_LEN;
    frames.push(buf.readUInt32LE(at));
    offsets.push(Number(buf.readBigUInt64LE(at + 4)));
  }
  return { frames, offsets };
}

/** The first entry whose frame is >= `frame` (binary search; frames are ascending). */
function lowerBound(frames: number[], frame: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (frames[mid]! < frame) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function parseTrack(track: string): { conceptIdx: number; objectId: number } | null {
  const m = /^(\d{1,3}):(\d{1,5})$/.exec(track);
  if (!m) return null;
  const conceptIdx = Number(m[1]);
  const objectId = Number(m[2]);
  return conceptIdx <= 255 && objectId <= 65535 ? { conceptIdx, objectId } : null;
}

/**
 * A valid .csmk holding only the records in the range: the same header with `count` rewritten,
 * then the records as the writer stored them (payload bytes verbatim). The frame range is a
 * slice by the index; only a track filter parses records.
 */
export function readMaskRange(csmkPath: string, idxPath: string, range: MaskRange = {}): Buffer {
  const idxFd = openSync(idxPath, "r");
  let index: Index;
  try {
    index = parseIndex(readAt(idxFd, 0, fstatSync(idxFd).size));
  } finally {
    closeSync(idxFd);
  }
  const fd = openSync(csmkPath, "r");
  try {
    const size = fstatSync(fd).size;
    const head = readAt(fd, 0, HEADER_LEN);
    if (head.toString("latin1", 0, 4) !== MAGIC) throw new CsmkError("bad magic");
    if (head.readUInt16LE(4) !== VERSION) throw new CsmkError(`unknown version ${head.readUInt16LE(4)}`);
    const first = lowerBound(index.frames, range.from ?? 0);
    const last = range.to === undefined ? index.frames.length : lowerBound(index.frames, range.to + 1);
    const start = first < index.offsets.length ? index.offsets[first]! : size;
    const end = last < index.offsets.length ? index.offsets[last]! : size;
    if (end < start || end > size) throw new CsmkError("index points outside the file");
    let body = end > start ? readAt(fd, start, end - start) : Buffer.alloc(0);

    const want = range.track === undefined ? null : parseTrack(range.track);
    if (range.track !== undefined && !want) throw new CsmkError("malformed track key");
    const kept: Buffer[] = [];
    let count = 0;
    for (let at = 0; at < body.length;) {
      if (at + RECORD_LEN > body.length) throw new CsmkError("truncated record");
      const len = RECORD_LEN + body.readUInt32LE(at + 27);
      if (at + len > body.length) throw new CsmkError("truncated payload");
      if (!want || (body.readUInt8(at + 4) === want.conceptIdx && body.readUInt16LE(at + 5) === want.objectId)) {
        kept.push(body.subarray(at, at + len));
        count++;
      }
      at += len;
    }
    body = want ? Buffer.concat(kept) : body;

    const out = Buffer.from(head);
    out.writeUInt32LE(count, 16);
    return Buffer.concat([out, body]);
  } finally {
    closeSync(fd);
  }
}
