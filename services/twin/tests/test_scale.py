"""Scale for a person's clip (FR-MEA-2, DESIGN §13.1): given, then from the marker, then unknown."""
from __future__ import annotations

import numpy as np
import pytest
from pydantic import ValidationError

from twin.app.main import ByoScale, KeyFramesBody, MetricsBody, SamIngestBody, summary
from twin.metrics.sam import resolve_scale
from twin.metrics.telemetry import Track, measure

FPS = 30.0
N = 150


def _track(width: float | None, frames=N, cx=0.0, cy=0.0) -> Track:
    fr = np.arange(frames)
    w = np.zeros(0) if width is None else np.full(frames, width)
    return Track(fr, np.full(frames, cx), np.full(frames, cy), np.full(frames, 5000.0), np.full(frames, 0.9), w)


def test_a_scale_the_caller_gives_wins():
    assert resolve_scale(_track(80.0), 0.25, 40.0, "user") == (0.25, "user")
    assert resolve_scale(_track(80.0), 0.5, None) == (0.5, "camera")


def test_marker_scale_is_size_over_median_box_width():
    ref = _track(80.0)
    # one frame with a wild box must not move the median
    ref.w[10] = 400.0
    scale, source = resolve_scale(ref, None, 40.0)
    assert source == "marker"
    assert scale == pytest.approx(0.5)


def test_without_a_scale_or_a_marker_width_it_is_unknown():
    for ref in (_track(None), Track.empty(), _track(0.0)):
        scale, source = resolve_scale(ref, None, 40.0)
        assert np.isnan(scale) and source == "uncalibrated"
    scale, source = resolve_scale(_track(80.0), None, None)
    assert np.isnan(scale) and source == "uncalibrated"


def _scene():
    rng = np.random.default_rng(1)
    fr = np.arange(N)
    t = fr / FPS
    s = 4.0 * np.sin(2 * np.pi * 4.0 * t)
    fault = Track(fr, 640 + s, np.full(N, 360.0) + rng.normal(0, 0.05, N), np.full(N, 5000.0), np.full(N, 0.9))
    a = Track(fr, np.full(N, 160.0) + rng.normal(0, 0.05, N), np.full(N, 650.0), np.full(N, 6400.0), np.full(N, 0.9))
    b = Track(fr, np.full(N, 1100.0) + rng.normal(0, 0.05, N), np.full(N, 650.0), np.full(N, 6400.0), np.full(N, 0.9))
    return fault, a, b


def test_an_unknown_scale_leaves_pixels_and_nulls_the_millimetres():
    m = measure(*_scene(), FPS, float("nan"), N)
    m.scale_source = "uncalibrated"
    assert m.a_px > 1.0 and m.f_star_hz == pytest.approx(4.0, abs=0.1)
    assert np.isnan(m.a_mm)
    out = summary(m, spectrum=False)
    assert out["rmsPx"] == pytest.approx(m.a_px, abs=1e-5)
    assert out["rmsMm"] is None and out["mmPerPx"] is None and out["scaleSource"] == "uncalibrated"


def test_a_twin_clip_still_reports_its_camera_scale():
    m = measure(*_scene(), FPS, 0.5, N)
    out = summary(m, spectrum=False)
    assert out["mmPerPx"] == 0.5 and out["scaleSource"] == "camera"
    assert out["rmsMm"] == pytest.approx(out["rmsPx"] * 0.5, rel=1e-4)


def test_a_real_clip_may_run_to_sixty_seconds():
    ok = dict(clipId="clp_x", csmkPath="masks/x.csmk", nFrames=1800, byo={"markerSizeMm": 40})
    assert MetricsBody(**ok).byo == ByoScale(markerSizeMm=40)
    with pytest.raises(ValidationError):
        MetricsBody(**{**ok, "nFrames": 1801})
    kf = KeyFramesBody(clipId="clp_x", clipPath="clips/x.mp4", csmkPath="masks/x.csmk", nFrames=1800, byo={"mmPerPx": 0.2})
    assert kf.byo.mmPerPx == 0.2


def test_scale_fields_are_checked():
    for bad in ({"mmPerPx": 0}, {"markerSizeMm": -1}, {"mmPerPx": 1e6}, {"nope": 1}):
        with pytest.raises(ValidationError):
            ByoScale(**bad)


def test_ingest_takes_both_dimensions_or_neither():
    src = [{"ssePath": "sam/x/forearm.sse", "conceptIdx": 0}]
    assert SamIngestBody(clipId="x", sources=src, fps=30, width=1280, height=720).width == 1280
    assert SamIngestBody(clipId="x", sources=src).width is None
    with pytest.raises(ValidationError):
        SamIngestBody(clipId="x", sources=src, width=1280)
