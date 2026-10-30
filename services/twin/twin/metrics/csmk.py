""".csmk v1: SAM mask records as the gateway stores them (TECHNICAL §7.4), little-endian.

Header  <4sHHHHfI  magic CSMK, version, flags, frameW, frameH, fps, count
Record  <IBH4ffI   frameIdx, conceptIdx, objectId, box x1 y1 x2 y2, conf, payloadLen; payload follows
Index   .csmk.idx  <4sHI (CSMI, version, count) then <IQ (frameIdx, offset) per first record of a frame

The payload is the SAM mask text verbatim ("H,W,~data" lossless or "H,W,!data" one_bit).
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

MAGIC = b"CSMK"
IDX_MAGIC = b"CSMI"
VERSION = 1
FLAG_LOSSLESS = 1
FLAG_ONE_BIT = 2
FLAG_CROP = 4

_HDR = struct.Struct("<4sHHHHfI")
_REC = struct.Struct("<IBH4ffI")
_IDX_HDR = struct.Struct("<4sHI")
_IDX = struct.Struct("<IQ")


class CsmkError(ValueError):
    pass


@dataclass(frozen=True)
class CsmkHeader:
    flags: int
    frame_w: int
    frame_h: int
    fps: float
    count: int


@dataclass(frozen=True)
class CsmkRecord:
    frame_idx: int
    concept_idx: int
    object_id: int
    box: tuple[float, float, float, float]
    conf: float
    payload: bytes

    @property
    def track_key(self) -> tuple[int, int]:
        return self.concept_idx, self.object_id


def parse(buf: bytes) -> tuple[CsmkHeader, list[CsmkRecord]]:
    if len(buf) < _HDR.size:
        raise CsmkError("truncated header")
    magic, version, flags, w, h, fps, count = _HDR.unpack_from(buf, 0)
    if magic != MAGIC:
        raise CsmkError("bad magic")
    if version != VERSION:
        raise CsmkError(f"unsupported version {version}")
    off, recs = _HDR.size, []
    for _ in range(count):
        if off + _REC.size > len(buf):
            raise CsmkError("truncated record")
        fi, ci, oid, x1, y1, x2, y2, conf, plen = _REC.unpack_from(buf, off)
        off += _REC.size
        if off + plen > len(buf):
            raise CsmkError("truncated payload")
        recs.append(CsmkRecord(fi, ci, oid, (x1, y1, x2, y2), conf, bytes(buf[off:off + plen])))
        off += plen
    if off != len(buf):
        raise CsmkError("trailing bytes")
    return CsmkHeader(flags, w, h, fps, count), recs


def read(path: Path) -> tuple[CsmkHeader, list[CsmkRecord]]:
    return parse(Path(path).read_bytes())


def dumps(header: CsmkHeader, records: list[CsmkRecord]) -> tuple[bytes, bytes]:
    """(csmk bytes, idx bytes). header.count is replaced by len(records)."""
    out = bytearray(_HDR.pack(MAGIC, VERSION, header.flags, header.frame_w, header.frame_h,
                              header.fps, len(records)))
    idx: list[tuple[int, int]] = []
    last = None
    for r in records:
        if r.frame_idx != last:
            idx.append((r.frame_idx, len(out)))
            last = r.frame_idx
        out += _REC.pack(r.frame_idx, r.concept_idx, r.object_id, *r.box, r.conf, len(r.payload))
        out += r.payload
    ib = bytearray(_IDX_HDR.pack(IDX_MAGIC, VERSION, len(idx)))
    for e in idx:
        ib += _IDX.pack(*e)
    return bytes(out), bytes(ib)


def write(path: Path, header: CsmkHeader, records: list[CsmkRecord]) -> None:
    path = Path(path)
    data, idx = dumps(header, records)
    path.write_bytes(data)
    path.with_name(path.name + ".idx").write_bytes(idx)
