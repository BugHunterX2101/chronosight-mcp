"""VisualTestResult and friends (PRD §15.2, DESIGN §14.3, DL-19)."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ReasonCode = Literal[
    "COVERAGE_LOW", "REL_REDUCTION_INSUFFICIENT", "ABOVE_CEILING", "SPECTRAL_DROP_INSUFFICIENT",
    "NEW_RESONANCE", "LOW_CONFIDENCE", "PATCH_RUNTIME_ERROR", "PATCH_BOUNDS_VIOLATION",
    "PATCH_TESTS_FAILED", "PATCH_SPEC", "STATE_CONFLICT",
    "BLINK_CODE_MISMATCH", "AREA_REDUCTION_INSUFFICIENT", "ROTATION_ABSENT",
    "POSITION_ERROR_HIGH", "VIBRATION_REDUCTION_INSUFFICIENT",
]


class _M(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")


class PreSummary(_M):
    rmsPx: float
    rmsMm: float
    fStarHz: float
    coverage: float


class PostSummary(_M):
    rmsPx: float | None
    rmsMm: float | None
    bandPowerDropDb: float | None
    coverage: float


class Criteria(_M):
    coverage: bool | None = None
    relative: bool | None = None
    absolute: bool | None = None
    spectral: bool | None = None
    noNewResonance: bool | None = None
    confidence: bool | None = None


class AssertionResult(_M):
    type: Literal["vibration", "position_error", "blink_code", "area_change", "rotation_present"]
    role: str
    pass_: bool = Field(alias="pass")
    reasons: list[ReasonCode] = []
    values: dict[str, float | str | None] = {}


class GroundTruth(_M):
    rmsMmTrue: float
    fStarHzTrue: float
    ampErrorPct: float | None = None
    freqErrorHz: float | None = None
    errorPct: float | None = None       # PRD §15.2 name, same value as ampErrorPct


class PrecheckFailure(_M):
    check: Literal["clipLength", "maskSize", "coverage", "markers", "oscillation"]
    message: str
    value: float | None = None


class PrecheckResult(_M):
    ok: bool
    failures: list[PrecheckFailure] = []


class VisualTestResult(_M):
    testId: str
    patchId: str                        # pat_… or "placebo"
    objectId: int | None = None
    pre: PreSummary
    post: PostSummary
    noiseFloorPx: float | None
    criteria: Criteria
    assertions: list[AssertionResult]
    warnings: list[str] = []
    verdict: Literal["PASS", "FAIL"]
    groundTruth: GroundTruth | None = None

    def dump(self) -> dict:
        return self.model_dump(by_alias=True, mode="json")
