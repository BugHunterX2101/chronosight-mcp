"""Reduced S1 sim for the read-only step-response tests (DESIGN §18.7, §18.9).

The sandbox image (sandbox/Dockerfile) bakes it read-only beside flat copies of plant.py
and abi.py, and links it into every patch workspace as /workspace/sim_harness/. It loads
the candidate's controller.py and params.py from the workspace root and runs a
closed-loop step from rest to STEP_RAD.
The run includes the scenario's warm-up, so the encoder brown-out happens inside the
run. DESIGN §20.2: a patch must write FILT after every reset, not just once. The controller
sees STATUS_RST in the same step as the reset and its register writes apply in that step,
so a compliant controller never has FILT at 0; `filtOffMs` is how long it was, and
tests/test_step_response.py requires 0.

`python sim_harness/step.py` prints the worst case over SEEDS as one JSON line, which is
what the independent harness reports as the candidate's StepMetrics.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import numpy as np

HARNESS = Path(__file__).resolve().parent
# In the sandbox image the harness, abi.py and tests live read-only under /opt (resolve()
# follows the workspace symlink there) and CS_WORKSPACE names the candidate's directory;
# a flat local copy needs neither.
HARNESS_ROOT = HARNESS.parent
WORKSPACE = Path(os.environ.get("CS_WORKSPACE") or HARNESS_ROOT)
for _p in (str(WORKSPACE), str(HARNESS_ROOT), str(HARNESS)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from plant import simulate  # noqa: E402  (needs the paths above)

STEP_RAD = 0.5          # commanded step, rad
WARMUP_S = 8.0          # scenario.yaml warmupS; the brown-out falls at 25–60 % of it
DURATION_S = 5.0        # scenario.yaml durationS
BAND = 0.02             # settling band, fraction of the step
SSE_WINDOW_S = 1.0      # steady-state error is the mean |error| over the last second
SEEDS = (11, 12, 13)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path.name}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_controller(seed: int):
    params = _load(f"_ws_params_{seed}", WORKSPACE / "params.py")
    ctrl = _load(f"_ws_controller_{seed}", WORKSPACE / "controller.py")
    return ctrl.Controller(dict(params.PARAMS))


def run_case(seed: int) -> dict:
    """Step-response metrics for one seed: overshootPct (%), settleSec (s), sse (rad), and
    filtOffMs, the time over warm-up and clip with the encoder filter off (ms)."""
    trace = simulate(load_controller(seed), np.random.SeedSequence(seed), DURATION_S, WARMUP_S, q_ref=STEP_RAD)
    total = WARMUP_S + DURATION_S
    filt_off_ms = float(np.count_nonzero(trace.filt == 0)) * trace.dt * 1000.0
    if trace.error is not None:
        return {"overshootPct": float("inf"), "settleSec": total, "sse": float("inf"),
                "filtOffMs": filt_off_ms, "error": trace.error}
    err = trace.q - STEP_RAD
    overshoot = max(0.0, float(np.max(trace.q)) - STEP_RAD) / STEP_RAD * 100.0
    outside = np.flatnonzero(np.abs(err) > BAND * STEP_RAD)
    settle = 0.0 if outside.size == 0 else min(total, float(trace.t[outside[-1]] - trace.t[0] + trace.dt))
    n = int(round(SSE_WINDOW_S / trace.dt))
    sse = float(np.mean(np.abs(err[-n:])))
    return {"overshootPct": overshoot, "settleSec": settle, "sse": sse, "filtOffMs": filt_off_ms, "error": None}


def worst() -> dict:
    cases = [run_case(s) for s in SEEDS]
    errors = [c["error"] for c in cases if c["error"]]
    return {
        "overshootPct": max(c["overshootPct"] for c in cases),
        "settleSec": max(c["settleSec"] for c in cases),
        "sse": max(c["sse"] for c in cases),
        "filtOffMs": max(c["filtOffMs"] for c in cases),
        "error": errors[0] if errors else None,
    }


if __name__ == "__main__":
    m = worst()
    # inf is not JSON; a crashed candidate reports null metrics and its error
    print(json.dumps({k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in m.items()}))
