// Reader for the .csmk mask container (TECHNICAL §6.9). Records are unaligned, so everything goes
// through a DataView. The token in each record is the SAM mask text verbatim: "H,W,<marker><data>".
import { decodeMaskToRaster } from "@meta-sam/parser";

const HEADER_LEN = 20;
const RECORD_LEN = 31;

export class CsmkError extends Error {}

export interface MaskRecord {
  frame: number;
  conceptIdx: number;
  objectId: number;
  /** x1, y1, x2, y2 in frame pixels. */
  box: [number, number, number, number];
  conf: number;
  /** Raster height and width (the crop, not the frame) and the encoded mask after the marker's comma. */
  h: number;
  w: number;
  encoding: "lossless" | "one_bit";
  payload: string;
}

export interface MaskFile {
  frameW: number;
  frameH: number;
  fps: number;
  count: number;
  byFrame: Map<number, MaskRecord[]>;
}

const TOKEN = /^(\d+),(\d+),([~!].*)$/s;

export function parseMasks(buf: ArrayBuffer): MaskFile {
  const dv = new DataView(buf);
  if (buf.byteLength < HEADER_LEN) throw new CsmkError("mask file is shorter than its header");
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== "CSMK") throw new CsmkError("bad mask magic");
  if (dv.getUint16(4, true) !== 1) throw new CsmkError(`unknown mask version ${dv.getUint16(4, true)}`);
  const frameW = dv.getUint16(8, true);
  const frameH = dv.getUint16(10, true);
  const fps = dv.getFloat32(12, true);
  const count = dv.getUint32(16, true);

  const byFrame = new Map<number, MaskRecord[]>();
  const text = new TextDecoder("latin1");
  let at = HEADER_LEN;
  for (let i = 0; i < count; i++) {
    if (at + RECORD_LEN > buf.byteLength) throw new CsmkError("mask file ends inside a record");
    const len = dv.getUint32(at + 27, true);
    if (at + RECORD_LEN + len > buf.byteLength) throw new CsmkError("mask file ends inside a payload");
    const m = TOKEN.exec(text.decode(new Uint8Array(buf, at + RECORD_LEN, len)));
    if (m === null) throw new CsmkError(`record ${i} has a malformed mask token`);
    const marker = m[3]![0];
    const rec: MaskRecord = {
      frame: dv.getUint32(at, true),
      conceptIdx: dv.getUint8(at + 4),
      objectId: dv.getUint16(at + 5, true),
      box: [dv.getFloat32(at + 7, true), dv.getFloat32(at + 11, true), dv.getFloat32(at + 15, true), dv.getFloat32(at + 19, true)],
      conf: dv.getFloat32(at + 23, true),
      h: Number(m[1]),
      w: Number(m[2]),
      encoding: marker === "~" ? "lossless" : "one_bit",
      payload: m[3]!,
    };
    const list = byFrame.get(rec.frame);
    if (list === undefined) byFrame.set(rec.frame, [rec]);
    else list.push(rec);
    at += RECORD_LEN + len;
  }
  return { frameW, frameH, fps, count, byFrame };
}

/** The 0/1 raster of one record, row-major, h*w. */
export function decodeRaster(rec: MaskRecord): Uint8Array {
  return decodeMaskToRaster({ encoding: rec.encoding, payload: rec.payload, width: rec.w, height: rec.h });
}
