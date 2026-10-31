"""D3 key frames for diagnosis (DESIGN §16.1, §16.3; FR-DIA-2, FR-PER-3).

The frames at the maximum and minimum displacement along the principal axis, and one near a zero
crossing between them. Every mask on those frames is outlined from the official
`decode_mask_to_svg_path`, and each frame is downscaled to a 768 px long edge.
"""
from __future__ import annotations

import base64
import re
from pathlib import Path

import cv2
import numpy as np
from meta_sam_parser import SegmentationMask, decode_mask_to_svg_path

from ..metrics.csmk import CsmkRecord
from ..metrics.telemetry import Telemetry

LONG_EDGE = 768
JPEG_QUALITY = 85
# BGR, by concept role: the fault object, the reference markers, and context objects.
COLOURS = {"fault": (60, 60, 255), "refs": (255, 200, 0), "context": (255, 255, 255)}
_NUM = re.compile(r"-?\d+(?:\.\d+)?")


class KeyFrameError(ValueError):
    pass


def pick(t: Telemetry) -> list[tuple[int, str, float]]:
    """(frameIdx, role, displacementPx) for the max, the min and a zero crossing, in frame order."""
    ok = np.isfinite(t.x)
    if ok.sum() < 3:
        raise KeyFrameError("too few fault samples to pick key frames")
    x = t.x[ok]
    frames = np.rint(t.t[ok] * t.fps).astype(int)
    i_max, i_min = int(np.argmax(x)), int(np.argmin(x))
    lo, hi = sorted((i_max, i_min))
    # Each sign change is represented by whichever of its two samples is nearer zero.
    cross = sorted({i if abs(x[i]) <= abs(x[i + 1]) else i + 1
                    for i in range(len(x) - 1) if x[i] == 0 or x[i] * x[i + 1] < 0})
    between = [i for i in cross if lo < i < hi]
    if between:
        # The crossing on the swing from one extreme to the other, at its smallest displacement.
        i_zero = min(between, key=lambda i: (abs(x[i]), i))
    elif cross:
        mid = (lo + hi) / 2
        i_zero = min(cross, key=lambda i: (abs(i - mid), i))
    else:
        i_zero = int(np.argmin(np.abs(x)))
    out: dict[int, tuple[int, str, float]] = {}
    for i, role in ((i_max, "max"), (i_min, "min"), (i_zero, "zero")):
        f = int(frames[i])
        out.setdefault(f, (f, role, round(float(x[i]), 3)))
    picked = sorted(out.values())
    if len(picked) < 2:
        raise KeyFrameError("the displacement extremes fall on one frame")
    return picked


def _subpaths(path: str) -> list[np.ndarray]:
    """SVG `M x y L x y … Z` subpaths as (n, 2) float arrays, in mask-local pixels."""
    out = []
    for part in path.split("M")[1:]:
        nums = [float(v) for v in _NUM.findall(part)]
        if len(nums) >= 4:
            out.append(np.asarray(nums[: len(nums) // 2 * 2], dtype=np.float64).reshape(-1, 2))
    return out


def outline(rec: CsmkRecord) -> list[np.ndarray]:
    """The mask outline in frame pixels: the crop-local path moved to the record's box origin."""
    h_s, w_s, body = rec.payload.decode("ascii").split(",", 2)
    enc = {"~": "lossless", "!": "one_bit"}.get(body[:1])
    if enc is None:
        raise KeyFrameError(f"unknown mask encoding {body[:1]!r}")
    path = decode_mask_to_svg_path(SegmentationMask(encoding=enc, payload=body, width=int(w_s), height=int(h_s)))
    return [p + np.array([rec.box[0], rec.box[1]]) for p in _subpaths(path)]


def _read_frames(clip: Path, wanted: set[int]) -> dict[int, np.ndarray]:
    cap = cv2.VideoCapture(str(clip))
    if not cap.isOpened():
        raise KeyFrameError(f"cannot open {clip.name}")
    got: dict[int, np.ndarray] = {}
    try:
        # Sequential reads, not seeks: H.264 seeking can land on a neighbouring frame.
        for i in range(max(wanted) + 1):
            ok, frame = cap.read()
            if not ok:
                break
            if i in wanted:
                got[i] = frame
    finally:
        cap.release()
    missing = wanted - got.keys()
    if missing:
        raise KeyFrameError(f"{clip.name} has no frame {min(missing)}")
    return got


def render(clip: Path, records: list[CsmkRecord], concepts: list[dict], t: Telemetry) -> list[dict]:
    picked = pick(t)
    frames = _read_frames(clip, {f for f, _, _ in picked})
    by_frame: dict[int, list[CsmkRecord]] = {}
    for r in records:
        by_frame.setdefault(r.frame_idx, []).append(r)
    out = []
    for f, role, disp in picked:
        img = frames[f].copy()
        drawn: set[str] = set()
        for r in by_frame.get(f, []):
            concept = concepts[r.concept_idx] if r.concept_idx < len(concepts) else {}
            colour = COLOURS.get(concept.get("role", ""), (255, 255, 255))
            # 4 fractional bits keep the half-pixel path coordinates.
            polys = [np.rint(p * 16).astype(np.int32) for p in outline(r)]
            cv2.polylines(img, polys, True, colour, 3, cv2.LINE_AA, 4)
            drawn.add(str(concept.get("slug", r.concept_idx)))
        h, w = img.shape[:2]
        scale = LONG_EDGE / max(h, w)
        if scale < 1:
            img = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        if not ok:
            raise KeyFrameError(f"JPEG encode failed for frame {f}")
        out.append({"frameIdx": f, "role": role, "displacementPx": disp, "objects": sorted(drawn),
                    "width": int(img.shape[1]), "height": int(img.shape[0]), "mime": "image/jpeg",
                    "dataBase64": base64.b64encode(buf.tobytes()).decode("ascii")})
    return out
