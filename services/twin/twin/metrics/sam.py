"""SAM 3.1 output to tracks (DESIGN §12.4, §13.2 steps 1-2).

Output text, one line per frame:
    <Nf>id<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..;c=..|><|mask;x=0;y=0;c=..;data=H,W,~payload|>,id<|...
The mask raster is H x W and covers the box, inclusive (placement mode "crop", SP-1).
The base85 alphabet excludes , ; < > | so the record regex below cannot split a payload.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

import numpy as np
from meta_sam_parser import SegmentationMask, decode_mask_to_raster

from .csmk import FLAG_CROP, FLAG_LOSSLESS, FLAG_ONE_BIT, CsmkHeader, CsmkRecord
from .telemetry import Telemetry, Track, assign_refs, measure

_FRAME = re.compile(r"<(\d+)f>")
_OBJ = re.compile(r"(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>")


class SamFormatError(ValueError):
    pass


def output_text(raw: bytes) -> tuple[str, dict]:
    """(output text, usage) from a raw Responses SSE stream. Deltas are the fallback."""
    done, deltas, usage = None, [], {}
    for line in raw.decode("utf-8").splitlines():
        if not line.startswith("data: {"):
            continue
        ev = json.loads(line[6:])
        t = ev.get("type")
        if t == "response.output_text.delta":
            deltas.append(ev.get("delta", ""))
        elif t == "response.output_text.done":
            done = ev.get("text", "")
        elif t == "response.completed":
            usage = (ev.get("response") or {}).get("usage") or {}
        elif t in ("response.failed", "response.incomplete", "error"):
            raise SamFormatError(f"stream ended with {t}")
    return (done if done is not None else "".join(deltas)), usage


def _kv(s: str) -> dict[str, str]:
    return dict(p.split("=", 1) for p in s.split(";") if "=" in p)


def parse_text(text: str, concept_idx: int) -> list[CsmkRecord]:
    recs: list[CsmkRecord] = []
    for line in text.splitlines():
        m = _FRAME.match(line)
        if not m:
            continue
        frame = int(m.group(1))
        for om in _OBJ.finditer(line, m.end()):
            box, mask = _kv(om.group(2)), om.group(3)
            if "data=" not in mask:
                raise SamFormatError(f"frame {frame}: mask without data")
            data = mask.split("data=", 1)[1]
            conf = float(box.get("c", _kv(mask).get("c", "1")))
            recs.append(CsmkRecord(frame, concept_idx, int(om.group(1)),
                                   (float(box["x1"]), float(box["y1"]), float(box["x2"]), float(box["y2"])),
                                   conf, data.encode("ascii")))
    return recs


def header_for(records: list[CsmkRecord], frame_w: int, frame_h: int, fps: float) -> CsmkHeader:
    enc = {r.payload.split(b",", 2)[2][:1] for r in records}
    flags = FLAG_CROP | (FLAG_LOSSLESS if b"~" in enc else 0) | (FLAG_ONE_BIT if b"!" in enc else 0)
    return CsmkHeader(flags, frame_w, frame_h, fps, len(records))


def decode(rec: CsmkRecord) -> tuple[float, float, float]:
    """(cx, cy, area) in frame pixels; centroid uses the +0.5 pixel-centre convention."""
    h_s, w_s, body = rec.payload.decode("ascii").split(",", 2)
    h, w = int(h_s), int(w_s)
    enc = {"~": "lossless", "!": "one_bit"}.get(body[:1])
    if enc is None:
        raise SamFormatError(f"unknown mask encoding {body[:1]!r}")
    raster = np.frombuffer(decode_mask_to_raster(SegmentationMask(encoding=enc, payload=body, width=w, height=h)),
                           dtype=np.uint8).reshape(h, w)
    ys, xs = np.nonzero(raster)
    area = float(xs.size)
    if area == 0:
        return np.nan, np.nan, 0.0
    x1, y1 = rec.box[0], rec.box[1]
    return float(x1 + xs.mean() + 0.5), float(y1 + ys.mean() + 0.5), area


def tracks(records: list[CsmkRecord], mapper=map) -> dict[tuple[int, int], Track]:
    """`mapper` lets the caller decode on a process pool (pool.map); decoding dominates the cost."""
    by_key: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for r, (cx, cy, area) in zip(records, mapper(decode, records)):
        if area > 0:
            by_key[r.track_key].append({"frame": r.frame_idx, "cx": cx, "cy": cy, "area": area, "conf": r.conf})
    return {k: Track.from_records(v) for k, v in by_key.items()}


def _longest(trs: list[Track], n: int) -> list[Track]:
    return sorted(trs, key=lambda t: (-len(t), float(t.cx.mean()) if len(t) else 0.0))[:n]


def role_tracks(records: list[CsmkRecord], concepts: list[dict], mapper=map) -> dict[str, Track]:
    """fault / refA / refB from the scenario's concept list (index = conceptIdx)."""
    per_concept: dict[int, list[Track]] = defaultdict(list)
    for (ci, _), tr in sorted(tracks(records, mapper).items(), key=lambda kv: kv[0]):
        per_concept[ci].append(tr)
    out = {"fault": Track.empty(), "refA": Track.empty(), "refB": Track.empty()}
    for ci, c in enumerate(concepts):
        found = per_concept.get(ci, [])
        if c["role"] == "fault":
            out["fault"] = (_longest(found, 1) or [Track.empty()])[0]
        elif c["role"] == "refs":
            out["refA"], out["refB"] = assign_refs(_longest(found, 2))
    return out


def telemetry(records: list[CsmkRecord], concepts: list[dict], fps: float, mm_per_px: float,
              n_frames: int, mapper=map) -> Telemetry:
    rt = role_tracks(records, concepts, mapper)
    return measure(rt["fault"], rt["refA"], rt["refB"], fps, mm_per_px, n_frames)


def records_from_sse(path: Path, concept_idx: int) -> tuple[list[CsmkRecord], dict]:
    text, usage = output_text(Path(path).read_bytes())
    return parse_text(text, concept_idx), usage
