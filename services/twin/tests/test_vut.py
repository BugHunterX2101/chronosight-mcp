"""Judge tests on synthetic telemetry (DESIGN §14.1-§14.3, §33)."""
from __future__ import annotations

import numpy as np
import pytest

from twin.metrics.telemetry import Track, measure
from twin.vut.evaluate import MSG, evaluate, failed_patch_result, precheck
from twin.vut.schema import VisualTestResult

FPS = 30.0
N = 150
SCALE = 0.2      # mm/px: keeps the 0.3 mm spec ceiling above small post amplitudes


def _track(frames, cx, cy, area=5000.0, conf=0.9) -> Track:
    frames = np.asarray(frames)
    return Track(frames, np.asarray(cx, float), np.asarray(cy, float),
                 np.full(frames.size, float(area)), np.full(frames.size, float(conf)))


def _tele(comps=((4.0, 4.0),), n=N, gap=0.0, jitter=0.05, seed=0, area=5000.0, conf=0.9, ref_b=True):
    """Telemetry for a fault vibrating along 30° with sum of (amplitude px, Hz) components."""
    rng = np.random.default_rng(seed)
    fr = np.arange(n)
    t = fr / FPS
    sx, sy = np.cumsum(rng.normal(0, 0.2, (2, n)), axis=1)
    u = np.array([np.cos(np.pi / 6), np.sin(np.pi / 6)])
    s = sum(a * np.sin(2 * np.pi * f * t + 0.4 + i) for i, (a, f) in enumerate(comps)) if comps else 0 * t
    keep = np.sort(rng.choice(n, int(round(n * (1 - gap))), replace=False))
    j = lambda: rng.normal(0, jitter, n)  # noqa: E731
    fault = _track(fr[keep], (640 + s * u[0] + sx + j())[keep], (360 + s * u[1] + sy + j())[keep], area, conf)
    a = _track(fr, 160 + sx + j(), 650 + sy + j(), 6400, conf)
    b = _track(fr, 1100 + sx + j(), 650 + sy + j(), 6400, conf) if ref_b else Track.empty()
    cmd = _track(fr, np.full(n, 640.0), np.full(n, 360.0))
    return measure(fault, a, b, FPS, SCALE, n, cmd)


@pytest.fixture(scope="module")
def pre():
    return _tele(seed=1)


def test_true_fix_passes(pre):
    r = evaluate(pre, _tele(((0.3, 4.0),), seed=2), "pat_fix")
    assert r.verdict == "PASS", r.assertions[0]
    assert all(r.criteria.model_dump().values())
    assert r.assertions[0].values["dropDb"] > 20


def test_placebo_fails_on_three_criteria(pre):
    r = evaluate(pre, _tele(seed=2), "placebo")
    assert r.verdict == "FAIL"
    assert {"REL_REDUCTION_INSUFFICIENT", "ABOVE_CEILING", "SPECTRAL_DROP_INSUFFICIENT"} <= set(r.assertions[0].reasons)


def test_half_fix_fails_relative(pre):
    r = evaluate(pre, _tele(((2.4, 4.0),), seed=2), "pat_half")
    assert "REL_REDUCTION_INSUFFICIENT" in r.assertions[0].reasons


def test_moving_the_resonance_fails(pre):
    r = evaluate(pre, _tele(((0.2, 4.0), (0.9, 8.2)), seed=2), "pat_shift")
    a = r.assertions[0]
    assert a.reasons == ["NEW_RESONANCE"], a
    assert a.values["newPeakHz"] == pytest.approx(8.2, abs=0.15)
    assert a.values["maxNewPeakDb"] > 6


def test_low_confidence_and_coverage(pre):
    r = evaluate(pre, _tele(((0.3, 4.0),), seed=2, conf=0.3, gap=0.2), "pat_blurry")
    assert {"LOW_CONFIDENCE", "COVERAGE_LOW"} <= set(r.assertions[0].reasons)


def test_ceiling_uses_noise_floor_when_larger(pre):
    noisy = _tele(((0.3, 4.0),), seed=2, jitter=0.6)
    r = evaluate(pre, noisy, "pat_fix")
    n0 = max(pre.n0_px, noisy.n0_px)
    assert r.assertions[0].values["ceilingMm"] == pytest.approx(max(3.0 * n0 * SCALE, 0.3), rel=1e-6)


@pytest.mark.parametrize("kw,check", [
    ({"n": 60}, "clipLength"),
    ({"area": 100.0}, "maskSize"),
    ({"ref_b": False}, "markers"),
    ({"gap": 0.2}, "coverage"),
    ({"comps": ()}, "oscillation"),
])
def test_precheck_blocks_with_design_messages(kw, check):
    pc = precheck(_tele(seed=3, **kw))
    assert not pc.ok
    f = {x.check: x for x in pc.failures}
    assert check in f and f[check].message == MSG[check]


def test_precheck_ok(pre):
    assert precheck(pre).ok


def test_schema_round_trip_and_alias(pre):
    r = evaluate(pre, _tele(((0.3, 4.0),), seed=2), "pat_fix")
    d = r.dump()
    assert "pass" in d["assertions"][0] and "pass_" not in d["assertions"][0]
    assert VisualTestResult.model_validate(d).dump() == d
    with pytest.raises(Exception):
        VisualTestResult.model_validate({**d, "surprise": 1})


def test_deterministic(pre):
    post = _tele(((0.3, 4.0),), seed=2)
    a, b = evaluate(pre, post, "pat_fix").dump(), evaluate(pre, post, "pat_fix").dump()
    assert a == b and a["testId"].startswith("vut_")


def test_failed_patch_result(pre):
    r = failed_patch_result(pre, "pat_crash", "PATCH_RUNTIME_ERROR", "ZeroDivisionError")
    assert r.verdict == "FAIL" and r.assertions[0].reasons == ["PATCH_RUNTIME_ERROR"]
    assert r.post.rmsMm is None and VisualTestResult.model_validate(r.dump()).verdict == "FAIL"
