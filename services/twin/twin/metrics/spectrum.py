"""Spectra on gapped samples (DESIGN §13.2 step 7, DL-17, ADR-006).

S(f) is a floating-mean Lomb-Scargle amplitude spectrum: at each frequency it is the
amplitude of the least-squares fit x ≈ a·cos ωt + b·sin ωt + c. A sinusoid of amplitude
A therefore peaks at A whatever the sample count or gap pattern, which makes pre and
post spectra with different coverage directly comparable.
"""
from __future__ import annotations

import numpy as np
from scipy.signal import welch

F_MIN_HZ = 0.5
BAND_HALF_HZ = 0.5
TINY = 1e-12


def freq_grid(t_span_s: float, fps: float) -> np.ndarray:
    """0.5 Hz .. 0.4·fps, step 1/(5·T_span) (5x oversampled)."""
    step = 1.0 / (5.0 * max(t_span_s, 1e-6))
    return np.arange(F_MIN_HZ, 0.4 * fps + step / 2, step)


def ls_amplitude(t: np.ndarray, x: np.ndarray, freqs: np.ndarray) -> np.ndarray:
    """Floating-mean LS amplitude spectrum; batched 3x3 normal equations per frequency."""
    t = np.asarray(t, dtype=np.float64)
    x = np.asarray(x, dtype=np.float64)
    w = 2.0 * np.pi * np.asarray(freqs, dtype=np.float64)[:, None]
    c = np.cos(w * t[None, :])
    s = np.sin(w * t[None, :])
    n = float(t.size)
    m = np.empty((len(freqs), 3, 3))
    m[:, 0, 0] = (c * c).sum(1)
    m[:, 0, 1] = m[:, 1, 0] = (c * s).sum(1)
    m[:, 1, 1] = (s * s).sum(1)
    m[:, 0, 2] = m[:, 2, 0] = c.sum(1)
    m[:, 1, 2] = m[:, 2, 1] = s.sum(1)
    m[:, 2, 2] = n
    rhs = np.stack([(c * x).sum(1), (s * x).sum(1), np.full(len(freqs), x.sum())], axis=1)
    coef = np.linalg.pinv(m) @ rhs[..., None]
    return np.hypot(coef[:, 0, 0], coef[:, 1, 0])


def db20(v: float) -> float:
    return float(20.0 * np.log10(max(float(v), TINY)))


def band_power_db(freqs: np.ndarray, spec: np.ndarray, f0: float, half: float = BAND_HALF_HZ) -> float:
    """Pband(f0) = 10·log10(Σ S² · df) over f0 ± half."""
    df = float(freqs[1] - freqs[0]) if len(freqs) > 1 else 1.0
    sel = np.abs(freqs - f0) <= half + 1e-9
    return float(10.0 * np.log10(max(float((spec[sel] ** 2).sum() * df), TINY)))


def smoothed_floor(freqs: np.ndarray, spec: np.ndarray, half: float = BAND_HALF_HZ) -> np.ndarray:
    """Local RMS of a noise spectrum over f ± half.

    One realisation of a noise spectrum is Rayleigh-distributed bin by bin, so comparing a
    single bin with a single bin is a coin toss. The local RMS is a stable estimate of the
    noise level that stays measured (and follows coloured noise) rather than assumed white.
    """
    if len(freqs) < 2:
        return np.asarray(spec, dtype=float).copy()
    w = int(round(half / float(freqs[1] - freqs[0])))
    cs = np.concatenate([[0.0], np.cumsum(np.asarray(spec, dtype=float) ** 2)])
    i = np.arange(len(freqs))
    lo, hi = np.maximum(i - w, 0), np.minimum(i + w + 1, len(freqs))
    return np.sqrt((cs[hi] - cs[lo]) / (hi - lo))


def local_maxima(spec: np.ndarray) -> np.ndarray:
    """Interior indices i with S[i] > S[i-1] and S[i] >= S[i+1]."""
    if len(spec) < 3:
        return np.array([], dtype=int)
    mid = spec[1:-1]
    return np.nonzero((mid > spec[:-2]) & (mid >= spec[2:]))[0] + 1


def welch_fstar(frames: np.ndarray, x: np.ndarray, fps: float, fmin: float, fmax: float) -> float:
    """Welch cross-check of f* (only meaningful at high coverage); gaps linearly interpolated."""
    frames = np.asarray(frames)
    full = np.arange(int(frames[0]), int(frames[-1]) + 1)
    xi = np.interp(full, frames, x)
    xi = xi - xi.mean()
    n = len(xi)
    f, p = welch(xi, fs=fps, window="hann", nperseg=n, nfft=16 * n, detrend=False)
    band = (f >= fmin) & (f <= fmax)
    return float(f[band][np.argmax(p[band])])
