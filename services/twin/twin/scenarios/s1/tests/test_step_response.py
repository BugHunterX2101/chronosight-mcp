"""Numeric step-response tests (PRD FR-PAT-3), mounted read-only in the sandbox.

The limits come from the approved patch spec the gateway writes to
/workspace/PATCH_SPEC.json; the agent edits only the target files, never these tests.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "sim_harness"))

import step  # noqa: E402

OBJ = json.loads((step.WORKSPACE / "PATCH_SPEC.json").read_text(encoding="utf-8"))["objectives"]


@pytest.fixture(scope="module", params=step.SEEDS, ids=lambda s: f"seed{s}")
def case(request):
    return step.run_case(request.param)


def test_runs_without_error(case):
    assert case["error"] is None, case["error"]


def test_overshoot(case):
    assert case["overshootPct"] <= OBJ["overshootPctMax"], f"overshoot {case['overshootPct']:.2f} %"


def test_settling_time(case):
    assert case["settleSec"] <= OBJ["settleSecMax"], f"settles in {case['settleSec']:.3f} s"


def test_steady_state_error(case):
    assert case["sse"] <= OBJ["sseMax"], f"steady-state error {case['sse']:.5f} rad"


def test_encoder_filter_after_every_reset(case):
    # DESIGN §20.2 and errata E-3 (p. 58): every reset clears FILT, so it must be rewritten each time.
    assert case["filtOffMs"] == 0, f"encoder filter off for {case['filtOffMs']:.0f} ms; rewrite FILT after every reset"
