"""Scenario run: seed tree, simulate, render. The one entry point `/render` and the tools use."""
from __future__ import annotations

import zlib
from functools import lru_cache
from pathlib import Path

import numpy as np
import yaml

from ..render import s1 as render_s1
from ..render import generic as render_generic
from ..scenarios.s1 import plant as plant_s1
from ..scenarios.s2 import plant as plant_s2
from ..scenarios.s3 import plant as plant_s3
from .loader import SCENARIOS, load_baseline


@lru_cache(maxsize=8)
def load_scenario(scenario_id: str) -> dict:
    with open(SCENARIOS / scenario_id / "scenario.yaml", encoding="utf-8") as fh:
        sc = yaml.safe_load(fh)
    if sc.get("version") != 1 or sc.get("id") != scenario_id:
        raise ValueError(f"bad scenario.yaml for {scenario_id}")
    return sc


def seed_tree(scenario_id: str, seed: int) -> tuple[np.random.SeedSequence, np.random.SeedSequence]:
    """(sim, render) child sequences from (scenarioSeed, runSeed), DESIGN §20.3."""
    root = np.random.SeedSequence([zlib.crc32(scenario_id.encode()), int(seed)])
    sim_ss, render_ss = root.spawn(2)
    return sim_ss, render_ss


def simulate(scenario_id: str, controller, seed: int, duration_s: float | None = None):
    sc = load_scenario(scenario_id)
    sim_ss, _ = seed_tree(scenario_id, seed)
    if scenario_id == "s1":
        return plant_s1.simulate(controller, sim_ss, duration_s or sc["durationS"], sc["warmupS"])
    if scenario_id == "s2":
        return plant_s2.simulate(controller, sim_ss, duration_s or sc["durationS"], sc["warmupS"])
    if scenario_id == "s3":
        return plant_s3.simulate(controller, sim_ss, duration_s or sc["durationS"], sc["warmupS"])
    raise ValueError(f"unsupported scenario {scenario_id}")


def render(scenario_id: str, trace, seed: int, out_dir: Path, name: str,
           duration_s: float | None = None, meta: dict | None = None) -> dict:
    sc = load_scenario(scenario_id)
    _, render_ss = seed_tree(scenario_id, seed)
    if scenario_id == "s1":
        cam = render_s1.Camera.from_scenario(sc)
        return render_s1.render_clip(trace.t, trace.q, float(trace.q_ref[0]), cam, render_ss,
                                     duration_s or sc["durationS"], out_dir, name, meta)
    return render_generic.render_clip(trace, scenario_id, seed, out_dir, name,
                                      duration_s or sc["durationS"], sc["fps"], meta)


def run_baseline(scenario_id: str, seed: int, out_dir: Path, name: str | None = None) -> dict:
    controller, params = load_baseline(scenario_id)
    trace = simulate(scenario_id, controller, seed)
    if trace.error:
        raise RuntimeError(f"baseline failed: {trace.error}")
    return render(scenario_id, trace, seed, out_dir, name or f"{scenario_id}-baseline-{seed}",
                  meta={"scenarioId": scenario_id, "seed": seed, "controller": "baseline", "params": params})
