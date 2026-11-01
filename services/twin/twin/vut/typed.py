from __future__ import annotations

import hashlib
import json
from typing import Any

from .schema import AssertionResult, Criteria, PostSummary, PreSummary, VisualTestResult


def _summary(gt: dict[str, Any]) -> dict[str, Any]:
    return gt.get("scenarioMetrics", {})


def evaluate_typed(scenario_id: str, pre_gt: dict[str, Any], post_gt: dict[str, Any],
                   patch_id: str, test_id: str | None = None) -> VisualTestResult:
    pre = _summary(pre_gt)
    post = _summary(post_gt)
    reasons: list[str] = []
    assertions: list[AssertionResult] = []
    if scenario_id == "s2":
        blink = post.get("ledCode") == "steady-on"
        area_pre = float(pre.get("hotspotArea", 0))
        area_post = float(post.get("hotspotArea", 0))
        rel = (area_post - area_pre) / area_pre if area_pre else 0.0
        area_ok = rel <= -0.5
        fan = float(post.get("fanRpm", 0))
        rotation_ok = 0.5 <= fan / 60.0 <= 4.0
        if not blink: reasons.append("BLINK_CODE_MISMATCH")
        if not area_ok: reasons.append("AREA_REDUCTION_INSUFFICIENT")
        if not rotation_ok: reasons.append("ROTATION_ABSENT")
        assertions = [
            AssertionResult(type="blink_code", role="fault", pass_=blink,
                            reasons=[] if blink else ["BLINK_CODE_MISMATCH"],
                            values={"pre": str(pre.get("ledCode")), "post": str(post.get("ledCode"))}),
            AssertionResult(type="area_change", role="fault", pass_=area_ok,
                            reasons=[] if area_ok else ["AREA_REDUCTION_INSUFFICIENT"],
                            values={"preArea": area_pre, "postArea": area_post, "relativeChange": rel}),
            AssertionResult(type="rotation_present", role="context", pass_=rotation_ok,
                            reasons=[] if rotation_ok else ["ROTATION_ABSENT"],
                            values={"fanRpm": fan}),
        ]
        criteria = Criteria()
    elif scenario_id == "s3":
        error = abs(float(post.get("positionErrorMm", 999.0)))
        vib_pre = float(pre.get("vibrationRms", 999.0))
        vib_post = float(post.get("vibrationRms", 999.0))
        position_ok = error <= 0.1
        vibration_ok = vib_post <= 0.3 * vib_pre
        if not position_ok: reasons.append("POSITION_ERROR_HIGH")
        if not vibration_ok: reasons.append("VIBRATION_REDUCTION_INSUFFICIENT")
        assertions = [
            AssertionResult(type="position_error", role="fault", pass_=position_ok,
                            reasons=[] if position_ok else ["POSITION_ERROR_HIGH"],
                            values={"positionErrorMm": error, "maxMm": 0.1}),
            AssertionResult(type="vibration", role="fault", pass_=vibration_ok,
                            reasons=[] if vibration_ok else ["VIBRATION_REDUCTION_INSUFFICIENT"],
                            values={"rmsPre": vib_pre, "rmsPost": vib_post, "ratio": vib_post / vib_pre if vib_pre else None}),
        ]
        criteria = Criteria()
    else:
        raise ValueError(f"typed assertions are not defined for {scenario_id}")
    digest = hashlib.sha256(json.dumps([scenario_id, patch_id, pre, post], sort_keys=True).encode()).hexdigest()
    passed = not reasons
    return VisualTestResult(
        testId=test_id or f"vut_{digest[:16]}", patchId=patch_id,
        pre=PreSummary(rmsPx=0, rmsMm=0, fStarHz=0, coverage=1),
        post=PostSummary(rmsPx=None, rmsMm=None, bandPowerDropDb=None, coverage=1),
        noiseFloorPx=None, criteria=criteria, assertions=assertions,
        verdict="PASS" if passed else "FAIL",
    )
