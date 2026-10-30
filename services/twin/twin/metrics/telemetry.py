"""Telemetry engine: masks/centroids to physical quantities (DESIGN §13.2).

Pure numpy; never imports twin.sim (T1: the judge only sees data). Ground truth from the
renderer enters through `tracks_from_ground_truth`, as data, exactly like SAM tracks.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .spectrum import F_MIN_HZ, freq_grid, ls_amplitude, smoothed_floor, welch_fstar

DETREND_HALF_S = 0.5
WELCH_COVERAGE_MIN = 0.98
WELCH_TOL_HZ = 0.2
MIN_SAMPLES = 8


@dataclass(frozen=True)
class Track:
    """One object's present frames. Centroids already use the +0.5 pixel-centre convention."""
    frames: np.ndarray            # int, strictly increasing
    cx: np.ndarray
    cy: np.ndarray
    area: np.ndarray              # mask pixel count
    conf: np.ndarray

    @classmethod
    def empty(cls) -> "Track":
        z = np.zeros(0)
        return cls(np.zeros(0, dtype=int), z, z, z, z)

    @classmethod
    def from_records(cls, recs: list[dict]) -> "Track":
        recs = sorted(recs, key=lambda r: r["frame"])
        if not recs:
            return cls.empty()
        col = lambda k, d=1.0: np.array([float(r.get(k, d)) for r in recs])  # noqa: E731
        return cls(np.array([int(r["frame"]) for r in recs]), col("cx"), col("cy"), col("area", 0.0), col("conf"))

    def __len__(self) -> int:
        return int(self.frames.size)

    def xy(self) -> np.ndarray:
        return np.stack([self.cx, self.cy], axis=1)

    def at(self, frames: np.ndarray) -> np.ndarray:
        """xy at the given frames (all must be present)."""
        idx = np.searchsorted(self.frames, frames)
        return self.xy()[idx]


@dataclass
class Telemetry:
    fps: float
    scale_mm_per_px: float
    n_frames: int
    t: np.ndarray                 # fault sample times (frames in T / fps)
    x: np.ndarray                 # principal-axis displacement, px
    u: np.ndarray                 # principal axis
    a_px: float
    a_mm: float
    p2p_px: float
    grid: np.ndarray
    spec: np.ndarray              # S(f), amplitude px
    f_star_hz: float
    tb: np.ndarray                # marker-B sample times
    xb: np.ndarray                # marker-B residual on u, px
    n0_px: float
    spec_n0: np.ndarray           # S_N0(f) on `grid`
    coverage: dict[str, float]
    conf_mean: float
    area_median: float
    warnings: list[str] = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return self.n_frames / self.fps

    @property
    def valid(self) -> bool:
        return self.t.size >= MIN_SAMPLES and np.isfinite(self.f_star_hz)

    def spectrum_on(self, grid: np.ndarray) -> np.ndarray:
        """S(f) on another grid, so pre and post compare bin for bin (§14.2)."""
        return ls_amplitude(self.t, self.x, grid) if self.t.size else np.zeros_like(grid)

    def noise_spectrum_on(self, grid: np.ndarray) -> np.ndarray:
        return ls_amplitude(self.tb, self.xb, grid) if self.tb.size else np.zeros_like(grid)

    def floor_on(self, grid: np.ndarray) -> np.ndarray:
        """Noise level per bin: local RMS of S_N0 (see `smoothed_floor`); NaN without marker B."""
        if not self.tb.size:
            return np.full(grid.shape, np.nan)
        return smoothed_floor(grid, self.noise_spectrum_on(grid))

    @property
    def a_signal_px(self) -> float:
        """A_px with the noise contribution removed: sqrt(max(A² − N0², 0)) (DECISIONS D-7)."""
        if not np.isfinite(self.n0_px):
            return self.a_px
        return float(np.sqrt(max(self.a_px ** 2 - self.n0_px ** 2, 0.0)))


def _moving_mean(t: np.ndarray, v: np.ndarray, half_s: float = DETREND_HALF_S) -> np.ndarray:
    """Mean of v over present samples within t_k ± half_s (gaps are not zero)."""
    lo = np.searchsorted(t, t - half_s - 1e-9, side="left")
    hi = np.searchsorted(t, t + half_s + 1e-9, side="right")
    cs = np.vstack([np.zeros((1, v.shape[1])), np.cumsum(v, axis=0)])
    return (cs[hi] - cs[lo]) / (hi - lo)[:, None]


def _principal_axis(d: np.ndarray) -> np.ndarray:
    if len(d) < 2:
        return np.array([1.0, 0.0])
    w, v = np.linalg.eigh(np.cov(d.T))
    u = v[:, int(np.argmax(w))]
    return -u if u[int(np.argmax(np.abs(u)))] < 0 else u   # deterministic sign


def assign_refs(markers: list[Track]) -> tuple[Track, Track]:
    """Marker A = smaller box-centre x at the first frame where both markers are present."""
    if len(markers) < 2:
        return (markers[0] if markers else Track.empty()), Track.empty()
    m0, m1 = markers[0], markers[1]
    both = np.intersect1d(m0.frames, m1.frames)
    if both.size == 0:
        return (m0, m1) if (len(m0) and (not len(m1) or m0.cx.mean() <= m1.cx.mean())) else (m1, m0)
    k = both[0]
    return (m0, m1) if m0.at(np.array([k]))[0, 0] <= m1.at(np.array([k]))[0, 0] else (m1, m0)


def measure(fault: Track, ref_a: Track, ref_b: Track, fps: float, scale_mm_per_px: float,
            n_frames: int, commanded: Track | None = None) -> Telemetry:
    coverage = {role: len(tr) / n_frames if n_frames else 0.0
                for role, tr in (("fault", fault), ("refA", ref_a), ("refB", ref_b))}
    tracked = [tr for tr in (fault, ref_a, ref_b) if len(tr)]
    conf_mean = float(np.concatenate([tr.conf for tr in tracked]).mean()) if tracked else 0.0
    area_median = float(np.median(fault.area)) if len(fault) else 0.0

    # 1. T = frames where fault and refA are present; nominal timestamps, gaps kept
    T = np.intersect1d(fault.frames, ref_a.frames)
    if commanded is not None:
        T = np.intersect1d(T, commanded.frames)
    t = T / fps
    span = float(t[-1] - t[0]) if T.size > 1 else n_frames / fps
    grid = freq_grid(span, fps)
    nan_spec = np.full(grid.shape, np.nan)
    if T.size < MIN_SAMPLES:
        return Telemetry(fps, scale_mm_per_px, n_frames, t, np.zeros(T.size), np.array([1.0, 0.0]),
                         np.nan, np.nan, np.nan, grid, nan_spec, np.nan, np.zeros(0), np.zeros(0),
                         np.nan, nan_spec, coverage, conf_mean, area_median, ["insufficientSamples"])

    # 2-3. centroids, ego-motion compensation with marker A
    a = ref_a.at(T)
    c_tilde = fault.at(T) - (a - a[0])

    # 4. detrend
    if commanded is not None:
        d = c_tilde - commanded.at(T)
        d = d - d.mean(axis=0)
    else:
        d = c_tilde - _moving_mean(t, c_tilde)

    # 5-6. principal axis, amplitudes
    u = _principal_axis(d)
    x = d @ u
    a_px = float(np.sqrt(np.mean(np.sum(d * d, axis=1))))
    p2p = float(x.max() - x.min())

    # 7. spectrum on gapped samples
    spec = ls_amplitude(t, x, grid)
    f_star = float(grid[int(np.argmax(spec))])

    # 8. noise floor with marker B, compensated by A and detrended exactly like the fault: with a
    #    commanded track the fault only loses its mean, and a static marker's "command" is constant,
    #    so B loses its mean too (DECISIONS D-6; the moving mean would shape S_N0 below ~1 Hz)
    Tb = np.intersect1d(ref_a.frames, ref_b.frames)
    warnings: list[str] = []
    if Tb.size >= MIN_SAMPLES:
        tb = Tb / fps
        ab = ref_a.at(Tb)
        b_tilde = ref_b.at(Tb) - (ab - ab[0])
        rb = b_tilde - (b_tilde.mean(axis=0) if commanded is not None else _moving_mean(tb, b_tilde))
        n0 = float(np.sqrt(np.mean(np.sum(rb * rb, axis=1))))
        xb = rb @ u
        spec_n0 = ls_amplitude(tb, xb, grid)
    else:
        tb, xb, n0, spec_n0 = np.zeros(0), np.zeros(0), np.nan, nan_spec
        warnings.append("noiseFloorUnavailable")

    # Welch cross-check (never changes the verdict)
    if coverage["fault"] >= WELCH_COVERAGE_MIN:
        fw = welch_fstar(T, x, fps, F_MIN_HZ, 0.4 * fps)
        if abs(fw - f_star) > WELCH_TOL_HZ:
            warnings.append("spectralDisagreement")

    return Telemetry(fps, scale_mm_per_px, n_frames, t, x, u, a_px, a_px * scale_mm_per_px, p2p,
                     grid, spec, f_star, tb, xb, n0, spec_n0, coverage, conf_mean, area_median, warnings)


def tracks_from_ground_truth(gt: dict, jitter_px: float = 0.0,
                             rng: np.random.Generator | None = None) -> dict[str, Track]:
    """Renderer ground truth as tracks (roles fault/refA/refB/commanded).

    `jitter_px` adds independent Gaussian centroid noise per role and axis, standing in for
    segmentation noise so the marker-B floor is not identically zero.
    """
    rng = rng or np.random.default_rng(0)
    frames = gt["framesGt"]
    out: dict[str, Track] = {}
    for role, key in (("fault", "forearm"), ("refA", "markerA"), ("refB", "markerB"), ("commanded", "commanded")):
        recs = []
        for f in frames:
            o = f[key]
            jx, jy = (rng.normal(0.0, jitter_px, 2) if jitter_px > 0 and role != "commanded" else (0.0, 0.0))
            recs.append({"frame": f["frame"], "cx": o["cx"] + jx, "cy": o["cy"] + jy,
                         "area": o.get("area", 0.0), "conf": 1.0})
        out[role] = Track.from_records(recs)
    return out


def measure_ground_truth(gt: dict, jitter_px: float = 0.0, rng: np.random.Generator | None = None) -> Telemetry:
    tr = tracks_from_ground_truth(gt, jitter_px, rng)
    return measure(tr["fault"], tr["refA"], tr["refB"], gt["fps"], gt["mmPerPx"], gt["frames"], tr["commanded"])
