"""Deterministic visual-unit-test judge (DESIGN §14.1-§14.3).

Models are witnesses, this module is the judge: it only sees Telemetry (data) and the
scenario's assertion parameters. It never imports twin.sim.
"""
from __future__ import annotations

import hashlib
import json

import numpy as np

from ..metrics.spectrum import F_MIN_HZ, band_power_db, db20, local_maxima
from ..metrics.telemetry import Telemetry
from .schema import (AssertionResult, Criteria, GroundTruth, PostSummary, PrecheckFailure, PrecheckResult,
                     PreSummary, VisualTestResult)

CLIP_MIN_S = 3.0
AREA_MIN_PX2 = 400.0
OSC_MARGIN_DB = 6.0
FLOOR_MARGIN_DB = 3.0
# Largest local maximum of a pure-noise LS spectrum over its smoothed floor, 0.5-12 Hz, 5 s clip:
# p99 13.4-13.7 dB, p99.9 14.6-15.0 dB (2000-trial MC, 0-10 % gaps; DECISIONS D-8)
NOISE_FA_DB = 14.0

DEFAULT_VIBRATION = {"r": 0.70, "k": 3.0, "aSpecMm": 0.3, "dropDbMin": 10.0, "newPeakDbMax": 6.0,
                     "confMin": 0.5, "coverageMin": 0.90}

MSG = {
    "clipLength": "Clip too short. Record at least 3 seconds.",
    "maskSize": "Move the camera closer.",
    "coverage": "The object was lost in too many frames.",
    "markers": "Place both reference markers in view.",
    "oscillation": "No oscillation above the noise floor in the 0.5–12 Hz band. Not visually testable.",
}


def _f(v) -> float | None:
    return None if v is None or not np.isfinite(v) else round(float(v), 6)


def precheck(m: Telemetry, coverage_min: float = 0.90, vibration: bool = True) -> PrecheckResult:
    """§14.1: is this fault visually testable? Any failure sends the run to BLOCKED."""
    fails: list[PrecheckFailure] = []
    if m.duration_s < CLIP_MIN_S:
        fails.append(PrecheckFailure(check="clipLength", message=MSG["clipLength"], value=_f(m.duration_s)))
    if m.area_median < AREA_MIN_PX2:
        fails.append(PrecheckFailure(check="maskSize", message=MSG["maskSize"], value=_f(m.area_median)))
    if m.coverage["refA"] == 0.0 or m.coverage["refB"] == 0.0:
        fails.append(PrecheckFailure(check="markers", message=MSG["markers"]))
    low = min(m.coverage.values())
    if low < coverage_min:
        fails.append(PrecheckFailure(check="coverage", message=MSG["coverage"], value=_f(low)))
    if vibration:
        ok = False
        if m.valid and np.isfinite(m.spec_n0).all():
            i = int(np.argmax(m.spec))
            in_band = F_MIN_HZ <= m.f_star_hz <= 0.4 * m.fps
            floor = m.floor_on(m.grid)
            ok = in_band and db20(m.spec[i]) >= db20(floor[i]) + max(OSC_MARGIN_DB, NOISE_FA_DB)
        if not ok:
            fails.append(PrecheckFailure(check="oscillation", message=MSG["oscillation"], value=_f(m.f_star_hz)))
    return PrecheckResult(ok=not fails, failures=fails)


def _test_id(patch_id: str, pre: Telemetry, post: Telemetry | None) -> str:
    h = hashlib.sha256(json.dumps([patch_id, pre.a_px, pre.f_star_hz,
                                   None if post is None else post.a_px]).encode()).hexdigest()
    return "vut_" + h[:16]


def _pre_summary(pre: Telemetry) -> PreSummary:
    return PreSummary(rmsPx=_f(pre.a_px) or 0.0, rmsMm=_f(pre.a_mm) or 0.0, fStarHz=_f(pre.f_star_hz) or 0.0,
                      coverage=round(min(pre.coverage.values()), 6))


def _ground_truth(post: Telemetry, gt_post: Telemetry | None) -> GroundTruth | None:
    if gt_post is None or not gt_post.valid:
        return None
    amp = abs(post.a_mm - gt_post.a_mm) / gt_post.a_mm * 100.0 if gt_post.a_mm > 0 and post.valid else None
    fe = abs(post.f_star_hz - gt_post.f_star_hz) if post.valid else None
    return GroundTruth(rmsMmTrue=_f(gt_post.a_mm), fStarHzTrue=_f(gt_post.f_star_hz),
                       ampErrorPct=_f(amp), freqErrorHz=_f(fe), errorPct=_f(amp))


def evaluate(pre: Telemetry, post: Telemetry, patch_id: str, params: dict | None = None,
             role: str = "fault", object_id: int | None = None, gt_post: Telemetry | None = None,
             test_id: str | None = None) -> VisualTestResult:
    """§14.2 vibration assertion: all six criteria must hold."""
    p = {**DEFAULT_VIBRATION, **(params or {})}
    reasons: list[str] = []
    grid = pre.grid

    # 1 coverage, pre and post, all three roles
    c_cov = min(pre.coverage.values()) >= p["coverageMin"] and min(post.coverage.values()) >= p["coverageMin"]
    # 2 relative reduction, on noise-corrected amplitudes (D-7): measured A² ≈ A_true² + N0²
    rel_ratio = post.a_signal_px / pre.a_signal_px if post.valid and pre.a_signal_px > 0 else np.nan
    c_rel = bool(post.valid and post.a_signal_px <= (1.0 - p["r"]) * pre.a_signal_px)
    # 3 absolute ceiling: A_post ≤ max(k·N0, A_spec), N0 = max(pre, post) floor (conservative)
    n0_px = float(np.nanmax([pre.n0_px, post.n0_px])) if np.isfinite([pre.n0_px, post.n0_px]).any() else np.nan
    ceiling_mm = max(p["k"] * n0_px * pre.scale_mm_per_px if np.isfinite(n0_px) else 0.0, p["aSpecMm"])
    c_abs = bool(post.valid and post.a_mm <= ceiling_mm)
    # 4 spectral drop at f*_pre, bin for bin on the pre grid
    s_pre = pre.spec
    s_post = post.spectrum_on(grid) if post.valid else np.full_like(grid, np.nan)
    drop_db = (band_power_db(grid, s_pre, pre.f_star_hz) - band_power_db(grid, s_post, pre.f_star_hz)
               if post.valid else np.nan)
    c_spec = bool(np.isfinite(drop_db) and drop_db >= p["dropDbMin"])
    # 5 no new resonance (D-8): a local maximum of S_post counts only if it clears the noise floor
    #   by the false-alarm margin; its rise is then measured against S_pre or the floor, whichever
    #   is larger, so a peak in a quiet band is not compared with a single noise bin
    max_new_db, new_peak_hz = None, None
    c_res = False
    if post.valid:
        floor = np.fmax(pre.floor_on(grid), post.floor_on(grid))
        floor_db = 20.0 * np.log10(np.maximum(floor, 1e-12))
        thresh_db = floor_db + max(FLOOR_MARGIN_DB, NOISE_FA_DB)
        c_res = True
        for i in local_maxima(s_post):
            if np.isfinite(thresh_db[i]) and db20(s_post[i]) <= thresh_db[i]:
                continue
            base_db = max(db20(s_pre[i]), floor_db[i]) if np.isfinite(floor_db[i]) else db20(s_pre[i])
            rise = db20(s_post[i]) - base_db
            if max_new_db is None or rise > max_new_db:
                max_new_db, new_peak_hz = rise, float(grid[i])
        if max_new_db is not None and max_new_db > p["newPeakDbMax"]:
            c_res = False
    # 6 confidence
    c_conf = min(pre.conf_mean, post.conf_mean) >= p["confMin"]

    for ok, code in ((c_cov, "COVERAGE_LOW"), (c_rel, "REL_REDUCTION_INSUFFICIENT"), (c_abs, "ABOVE_CEILING"),
                     (c_spec, "SPECTRAL_DROP_INSUFFICIENT"), (c_res, "NEW_RESONANCE"), (c_conf, "LOW_CONFIDENCE")):
        if not ok:
            reasons.append(code)
    passed = not reasons

    assertion = AssertionResult(
        type="vibration", role=role, pass_=passed, reasons=reasons,
        values={"aPreMm": _f(pre.a_mm), "aPostMm": _f(post.a_mm), "relRatio": _f(rel_ratio), "dropDb": _f(drop_db),
                "maxNewPeakDb": _f(max_new_db), "newPeakHz": _f(new_peak_hz), "ceilingMm": _f(ceiling_mm)})
    warnings = sorted(set(pre.warnings) | set(post.warnings))
    return VisualTestResult(
        testId=test_id or _test_id(patch_id, pre, post), patchId=patch_id, objectId=object_id,
        pre=_pre_summary(pre),
        post=PostSummary(rmsPx=_f(post.a_px), rmsMm=_f(post.a_mm), bandPowerDropDb=_f(drop_db),
                         coverage=round(min(post.coverage.values()), 6)),
        noiseFloorPx=_f(n0_px),
        criteria=Criteria(coverage=c_cov, relative=c_rel, absolute=c_abs, spectral=c_spec,
                          noNewResonance=c_res, confidence=c_conf),
        assertions=[assertion], warnings=warnings, verdict="PASS" if passed else "FAIL",
        groundTruth=_ground_truth(post, gt_post))


def failed_patch_result(pre: Telemetry, patch_id: str, code: str, detail: str = "",
                        role: str = "fault", object_id: int | None = None,
                        test_id: str | None = None) -> VisualTestResult:
    """FAIL without a post clip: the patch crashed, hung, broke bounds or failed its tests."""
    return VisualTestResult(
        testId=test_id or _test_id(patch_id, pre, None), patchId=patch_id, objectId=object_id,
        pre=_pre_summary(pre),
        post=PostSummary(rmsPx=None, rmsMm=None, bandPowerDropDb=None, coverage=0.0),
        noiseFloorPx=_f(pre.n0_px), criteria=Criteria(),
        assertions=[AssertionResult(type="vibration", role=role, pass_=False, reasons=[code],
                                    values={"aPreMm": _f(pre.a_mm), "detail": detail[:500] or None})],
        warnings=list(pre.warnings), verdict="FAIL")
