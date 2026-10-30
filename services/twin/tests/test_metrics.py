"""Property tests for the telemetry engine on synthetic signals (DESIGN §13, §33)."""
from __future__ import annotations

import numpy as np
import pytest

from twin.metrics.spectrum import db20, freq_grid, ls_amplitude
from twin.metrics.telemetry import Track, assign_refs, measure

FPS = 30.0
N = 150


def _track(frames, cx, cy, area=5000.0, conf=0.9) -> Track:
    frames = np.asarray(frames)
    return Track(frames, np.asarray(cx, float), np.asarray(cy, float),
                 np.full(frames.size, area), np.full(frames.size, conf))


def _scene(amp=4.0, f=4.0, gap=0.0, shake=1.0, jitter=0.05, seed=0, extra=None):
    """Fault oscillating along a 30° axis, camera shake common to every object."""
    rng = np.random.default_rng(seed)
    fr = np.arange(N)
    t = fr / FPS
    sx, sy = np.cumsum(rng.normal(0, shake * 0.2, (2, N)), axis=1)
    u = np.array([np.cos(np.pi / 6), np.sin(np.pi / 6)])
    s = amp * np.sin(2 * np.pi * f * t + 0.4)
    if extra is not None:
        s = s + extra(t)
    fx, fy = 640 + s * u[0] + sx, 360 + s * u[1] + sy
    keep = np.sort(rng.choice(N, int(round(N * (1 - gap))), replace=False))
    j = lambda: rng.normal(0, jitter, N)  # noqa: E731
    fault = _track(fr[keep], (fx + j())[keep], (fy + j())[keep])
    ref_a = _track(fr, 160 + sx + j(), 650 + sy + j(), area=6400)
    ref_b = _track(fr, 1100 + sx + j(), 650 + sy + j(), area=6400)
    cmd = _track(fr, np.full(N, 640.0), np.full(N, 360.0))
    return fault, ref_a, ref_b, cmd


@pytest.mark.parametrize("gap", [0.0, 0.10, 0.30])
@pytest.mark.parametrize("f", [1.3, 4.0, 8.2, 11.5])
def test_spectrum_normalization_under_gaps(gap, f):
    rng = np.random.default_rng(int(f * 10) + int(gap * 100))
    t = np.arange(N) / FPS
    keep = np.sort(rng.choice(N, int(N * (1 - gap)), replace=False))
    x = 2.0 * np.sin(2 * np.pi * f * t + 0.7) + 3.0       # offset: floating mean must absorb it
    grid = freq_grid(t[keep][-1] - t[keep][0], FPS)
    s = ls_amplitude(t[keep], x[keep], grid)
    assert abs(db20(s.max()) - db20(2.0)) <= 0.5
    assert abs(grid[int(np.argmax(s))] - f) <= 0.1


@pytest.mark.parametrize("gap", [0.0, 0.10, 0.30])
def test_measure_recovers_amplitude_and_frequency(gap):
    fault, a, b, cmd = _scene(amp=4.0, f=4.0, gap=gap)
    m = measure(fault, a, b, FPS, 0.5, N, cmd)
    true_rms = 4.0 / np.sqrt(2)
    assert m.a_px == pytest.approx(true_rms, rel=0.05)
    assert m.a_mm == pytest.approx(m.a_px * 0.5)
    assert m.f_star_hz == pytest.approx(4.0, abs=0.1)
    assert abs(abs(m.u @ np.array([np.cos(np.pi / 6), np.sin(np.pi / 6)])) - 1) < 1e-2
    assert m.coverage["fault"] == pytest.approx(1 - gap, abs=0.01)


def test_moving_mean_branch_without_commanded():
    fault, a, b, _ = _scene(amp=4.0, f=4.0)
    m = measure(fault, a, b, FPS, 0.5, N, None)
    assert m.f_star_hz == pytest.approx(4.0, abs=0.1)
    assert m.a_px == pytest.approx(4.0 / np.sqrt(2), rel=0.15)


def test_ego_motion_is_removed():
    calm = measure(*_scene(shake=0.0, seed=3)[:3], FPS, 0.5, N, _scene()[3])
    shaky = measure(*_scene(shake=5.0, seed=3)[:3], FPS, 0.5, N, _scene()[3])
    assert shaky.a_px == pytest.approx(calm.a_px, rel=0.03)


def test_noise_floor_tracks_marker_jitter():
    for jit in (0.05, 0.3):
        m = measure(*_scene(jitter=jit, seed=5)[:3], FPS, 0.5, N, _scene()[3])
        # B − A doubles the variance; the ±0.5 s moving mean removes a little of it
        assert m.n0_px == pytest.approx(jit * 2.0, rel=0.25)


def test_assign_refs_by_x_at_first_shared_frame():
    fr = np.arange(10)
    left = _track(fr, np.full(10, 100.0), np.zeros(10))
    right = _track(fr[3:], np.full(7, 900.0), np.zeros(7))
    assert assign_refs([right, left]) == (left, right)
    a, b = assign_refs([left])
    assert a is left and len(b) == 0


def test_insufficient_samples_is_not_valid():
    fault, a, b, cmd = _scene()
    short = _track(fault.frames[:4], fault.cx[:4], fault.cy[:4])
    m = measure(short, a, b, FPS, 0.5, N, cmd)
    assert not m.valid and "insufficientSamples" in m.warnings
