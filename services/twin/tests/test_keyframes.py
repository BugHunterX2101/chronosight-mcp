"""D3 key frames (DESIGN §16.1, FR-DIA-2): frame choice, and outlines drawn on a real clip."""
from __future__ import annotations

import base64
from pathlib import Path

import cv2
import numpy as np
import pytest

from twin.metrics import csmk
from twin.metrics.telemetry import Track, measure
from twin.render import keyframes as kf

FPS = 30.0
N = 150
DATA = Path(__file__).resolve().parents[3] / "data"
# A baseline S1 render and the masks the real SAM endpoint returned for it, when this checkout has them.
CLIP = DATA / "clips" / "s1-baseline-7-40023a94.mp4"
MASKS = DATA / "masks" / "bl-40023a94988bd7a854da1ef414465ee0.csmk"


def _track(frames, cx, cy, area=5000.0) -> Track:
    frames = np.asarray(frames)
    return Track(frames, np.asarray(cx, float), np.asarray(cy, float), np.full(frames.size, area), np.full(frames.size, 0.9))


def _telemetry(amp=4.0, f=2.0):
    fr = np.arange(N)
    s = amp * np.sin(2 * np.pi * f * fr / FPS + 0.4)
    fault = _track(fr, 640 + s, np.full(N, 360.0))
    ref_a = _track(fr, np.full(N, 160.0), np.full(N, 650.0), 6400)
    ref_b = _track(fr, np.full(N, 1100.0), np.full(N, 650.0), 6400)
    return measure(fault, ref_a, ref_b, FPS, 0.5, N)


def test_picks_extremes_and_a_crossing_between_them():
    t = _telemetry()
    picked = kf.pick(t)
    roles = {role: (f, d) for f, role, d in picked}
    assert set(roles) == {"max", "min", "zero"}
    assert [f for f, _, _ in picked] == sorted(f for f, _, _ in picked)
    (f_max, d_max), (f_min, d_min), (f_zero, d_zero) = roles["max"], roles["min"], roles["zero"]
    assert d_max > 0 > d_min
    assert min(f_max, f_min) < f_zero < max(f_max, f_min)
    assert abs(d_zero) < 0.25 * min(d_max, -d_min)


def test_refuses_a_track_without_samples():
    t = _telemetry()
    t.x[:] = np.nan
    with pytest.raises(kf.KeyFrameError):
        kf.pick(t)


@pytest.mark.skipif(not (CLIP.is_file() and MASKS.is_file()), reason="no rendered S1 baseline with real SAM masks here")
def test_outlines_real_masks_on_the_real_clip():
    from twin.app import main as app

    t = app._measure_csmk("s1", MASKS, N)
    _, recs = csmk.read(MASKS)
    frames = kf.render(CLIP, recs, app.load_scenario("s1")["concepts"], t)
    assert 2 <= len(frames) <= 4
    for fr in frames:
        assert (fr["width"], fr["height"]) == (768, 432)
        assert set(fr["objects"]) >= {"forearm", "marker"}
        img = cv2.imdecode(np.frombuffer(base64.b64decode(fr["dataBase64"]), np.uint8), cv2.IMREAD_COLOR)
        assert img.shape == (432, 768, 3)
    # Every outline lies on its record's box: the path is moved to the crop origin.
    rec = next(r for r in recs if r.frame_idx == frames[0]["frameIdx"] and r.concept_idx == 0)
    pts = np.concatenate(kf.outline(rec))
    x1, y1, x2, y2 = rec.box
    assert pts[:, 0].min() >= x1 - 1 and pts[:, 0].max() <= x2 + 1
    assert pts[:, 1].min() >= y1 - 1 and pts[:, 1].max() <= y2 + 1
