// .csmk range reads (TECHNICAL §6.9, DESIGN §10). The files are laid out byte by byte from the spec,
// the same layout twin/metrics/csmk.py writes.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CsmkError, parseTrack, readMaskRange } from "../src/csmk.ts";

interface Rec { frame: number; concept: number; object: number; payload: string }

function header(count: number): Buffer {
  const b = Buffer.alloc(20);
  b.write("CSMK", 0, "latin1");
  b.writeUInt16LE(1, 4);
  b.writeUInt16LE(5, 6); // lossless + crop
  b.writeUInt16LE(640, 8);
  b.writeUInt16LE(480, 10);
  b.writeFloatLE(30, 12);
  b.writeUInt32LE(count, 16);
  return b;
}

function record(r: Rec): Buffer {
  const payload = Buffer.from(r.payload, "latin1");
  const b = Buffer.alloc(31);
  b.writeUInt32LE(r.frame, 0);
  b.writeUInt8(r.concept, 4);
  b.writeUInt16LE(r.object, 5);
  [1, 2, 3, 4].forEach((v, i) => b.writeFloatLE(v, 7 + i * 4));
  b.writeFloatLE(0.5, 23);
  b.writeUInt32LE(payload.length, 27);
  return Buffer.concat([b, payload]);
}

const dir = mkdtempSync(join(tmpdir(), "csmk-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, recs: Rec[]): { csmk: string; idx: string } {
  const body: Buffer[] = [];
  const firsts: { frame: number; offset: number }[] = [];
  let offset = 20;
  for (const r of recs) {
    if (!firsts.length || firsts[firsts.length - 1]!.frame !== r.frame) firsts.push({ frame: r.frame, offset });
    const rb = record(r);
    body.push(rb);
    offset += rb.length;
  }
  const idxHead = Buffer.alloc(10);
  idxHead.write("CSMI", 0, "latin1");
  idxHead.writeUInt16LE(1, 4);
  idxHead.writeUInt32LE(firsts.length, 6);
  const entries = firsts.map((f) => {
    const e = Buffer.alloc(12);
    e.writeUInt32LE(f.frame, 0);
    e.writeBigUInt64LE(BigInt(f.offset), 4);
    return e;
  });
  const csmk = join(dir, `${name}.csmk`);
  writeFileSync(csmk, Buffer.concat([header(recs.length), ...body]));
  writeFileSync(`${csmk}.idx`, Buffer.concat([idxHead, ...entries]));
  return { csmk, idx: `${csmk}.idx` };
}

// Frames 0, 1 and 3 have records; frame 2 has none ("missing is not zero", FR-PER-5).
const RECS: Rec[] = [
  { frame: 0, concept: 0, object: 1, payload: "4,4,~aaaa" },
  { frame: 0, concept: 1, object: 7, payload: "4,4,~bb" },
  { frame: 1, concept: 0, object: 1, payload: "4,4,~cccccc" },
  { frame: 3, concept: 0, object: 1, payload: "4,4,~d" },
  { frame: 3, concept: 1, object: 7, payload: "4,4,~eeeee" },
];
const frames = (b: Buffer): number[] => {
  const out: number[] = [];
  for (let at = 20; at < b.length;) {
    out.push(b.readUInt32LE(at));
    at += 31 + b.readUInt32LE(at + 27);
  }
  return out;
};

describe("readMaskRange", () => {
  const f = write("a", RECS);

  it("returns the whole file, byte for byte, when no range is given", () => {
    const whole = readMaskRange(f.csmk, f.idx);
    expect(whole.equals(Buffer.concat([header(5), ...RECS.map(record)]))).toBe(true);
  });

  it("slices by frame and rewrites the record count in the header", () => {
    const part = readMaskRange(f.csmk, f.idx, { from: 1, to: 3 });
    expect(frames(part)).toEqual([1, 3, 3]);
    expect(part.readUInt32LE(16)).toBe(3);
    expect(part.subarray(0, 16).equals(header(0).subarray(0, 16))).toBe(true);
  });

  it("treats `to` as inclusive and skips frames that have no record", () => {
    expect(frames(readMaskRange(f.csmk, f.idx, { from: 2, to: 2 }))).toEqual([]);
    expect(frames(readMaskRange(f.csmk, f.idx, { from: 0, to: 0 }))).toEqual([0, 0]);
    expect(frames(readMaskRange(f.csmk, f.idx, { from: 2 }))).toEqual([3, 3]);
  });

  it("filters one track and keeps its payload bytes verbatim", () => {
    const part = readMaskRange(f.csmk, f.idx, { track: "1:7" });
    expect(frames(part)).toEqual([0, 3]);
    expect(part.readUInt32LE(16)).toBe(2);
    expect(part.includes(Buffer.from("4,4,~bb"))).toBe(true);
    expect(part.includes(Buffer.from("4,4,~aaaa"))).toBe(false);
  });

  it("gives an empty but valid file past the last frame", () => {
    const part = readMaskRange(f.csmk, f.idx, { from: 99 });
    expect(part.length).toBe(20);
    expect(part.readUInt32LE(16)).toBe(0);
  });

  it("rejects an unknown version, a bad magic, a bad track and a truncated file", () => {
    const idx = readFileSync(f.idx);
    const bad = Buffer.from(header(0));
    bad.writeUInt16LE(2, 4);
    const v = join(dir, "v.csmk");
    writeFileSync(v, bad);
    writeFileSync(`${v}.idx`, idx);
    expect(() => readMaskRange(v, `${v}.idx`)).toThrow(CsmkError);

    const m = join(dir, "m.csmk");
    writeFileSync(m, Buffer.concat([Buffer.from("XXXX"), header(0).subarray(4)]));
    writeFileSync(`${m}.idx`, idx);
    expect(() => readMaskRange(m, `${m}.idx`)).toThrow(/magic/);

    expect(() => readMaskRange(f.csmk, f.idx, { track: "nope" })).toThrow(/track/);

    const cut = join(dir, "cut.csmk");
    writeFileSync(cut, Buffer.concat([header(5), ...RECS.map(record)]).subarray(0, 100));
    writeFileSync(`${cut}.idx`, idx);
    expect(() => readMaskRange(cut, `${cut}.idx`)).toThrow(CsmkError);
  });
});

describe("parseTrack", () => {
  it("accepts <conceptIdx>:<objectId> within u8 and u16", () => {
    expect(parseTrack("0:1")).toEqual({ conceptIdx: 0, objectId: 1 });
    expect(parseTrack("255:65535")).toEqual({ conceptIdx: 255, objectId: 65535 });
    for (const t of ["256:1", "1:65536", "1", "a:b", "1:2:3", "-1:2", ""]) expect(parseTrack(t)).toBeNull();
  });
});
