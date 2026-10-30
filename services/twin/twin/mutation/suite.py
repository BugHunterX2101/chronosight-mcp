"""Mutation suite (DESIGN §14.4): every S1 patch on every mutation seed, through the judge.

The suite validates the judge, not the patches: each case has an expected verdict and an
expected reason, and a row counts as correct only if both match. The pre clip is always the
baseline on the same seed.

`runner` is injected so the in-process path works today and `twin.hotload` can replace it:
    runner(pkg_dir, seed) -> RunOutcome
"""
from __future__ import annotations

import argparse
import ast
import json
from collections.abc import Callable
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..metrics.telemetry import measure_ground_truth
from ..sim.loader import SCENARIOS, load_baseline, load_controller
from ..sim.run import render, simulate
from ..vut.evaluate import evaluate, failed_patch_result, precheck

PATCHES = Path(__file__).parent / "patches"
MUTATION_SEEDS = tuple(range(101, 111))
JITTERS_PX = (0.05, 0.3)
EXPECTED = {   # case -> (verdict, reason that must be present)
    "v1": ("PASS", None),
    "v2": ("FAIL", None),
    "v3": ("FAIL", "REL_REDUCTION_INSUFFICIENT"),
    "v4": ("FAIL", "NEW_RESONANCE"),
    "v5": ("FAIL", "PATCH_RUNTIME_ERROR"),
}
VALUE_KEYS = ("aPostMm", "relRatio", "ceilingMm", "dropDb", "maxNewPeakDb", "newPeakHz")


@dataclass
class RunOutcome:
    trace: object | None              # plant trace when the run completed
    code: str | None = None           # PATCH_* reason when it did not
    detail: str = ""


Runner = Callable[[Path, int], RunOutcome]


def in_process_runner(pkg_dir: Path, seed: int, scenario_id: str = "s1") -> RunOutcome:
    """Load and run the patch in this interpreter (no isolation; trusted fixtures only)."""
    abi = SCENARIOS / scenario_id / "baseline" / "abi.py"
    try:
        ctrl, _ = load_controller(pkg_dir, abi)
    except Exception as exc:  # noqa: BLE001 - any import failure is a runtime error of the patch
        return RunOutcome(None, "PATCH_RUNTIME_ERROR", f"{type(exc).__name__}: {exc}")
    trace = simulate(scenario_id, ctrl, seed)
    if trace.error:
        return RunOutcome(None, "PATCH_RUNTIME_ERROR", trace.error)
    return RunOutcome(trace)


def ast_identical(pkg_dir: Path, scenario_id: str = "s1") -> bool:
    """Placebo check: every .py in the patch parses to the same AST as the baseline file."""
    base = SCENARIOS / scenario_id / "baseline"
    files = sorted(pkg_dir.glob("*.py"))
    if not files:
        return False
    for f in files:
        b = base / f.name
        if not b.exists():
            return False
        if ast.dump(ast.parse(f.read_text("utf-8"))) != ast.dump(ast.parse(b.read_text("utf-8"))):
            return False
    return True


def _gt(trace, seed: int, out_dir: Path, name: str, scenario_id: str) -> dict:
    gt_path = out_dir / f"{name}.gt.json"
    if not gt_path.exists():
        render(scenario_id, trace, seed, out_dir, name)
    return json.loads(gt_path.read_text("utf-8"))


def _jitter_rng(seed: int, jitter_idx: int, stream: int) -> np.random.Generator:
    """Independent segmentation-noise stream per (seed, jitter level, pre=0/post=1)."""
    return np.random.default_rng(np.random.SeedSequence([seed, jitter_idx, stream]))


def run_seed(seed: int, cases: tuple[str, ...], out_dir: Path, jitters: tuple[float, ...] = JITTERS_PX,
             runner: Runner | None = None, scenario_id: str = "s1") -> list[dict]:
    runner = runner or in_process_runner
    out_dir = Path(out_dir)
    base, _ = load_baseline(scenario_id)
    tr = simulate(scenario_id, base, seed)
    if tr.error:
        raise RuntimeError(f"baseline failed on seed {seed}: {tr.error}")
    gt_pre = _gt(tr, seed, out_dir, f"pre-{seed}", scenario_id)

    posts = {}
    for case in cases:
        pkg = PATCHES / scenario_id / case
        res = runner(pkg, seed)
        gt_post = None if res.trace is None else _gt(res.trace, seed, out_dir, f"{case}-{seed}", scenario_id)
        posts[case] = (res, gt_post, ast_identical(pkg, scenario_id))

    rows = []
    for ji, jit in enumerate(jitters):
        pre = measure_ground_truth(gt_pre, jit, _jitter_rng(seed, ji, 0))
        pc = precheck(pre)
        for case, (res, gt_post, placebo) in posts.items():
            if res.trace is None:
                r = failed_patch_result(pre, case, res.code or "PATCH_RUNTIME_ERROR", res.detail)
            else:
                post = measure_ground_truth(gt_post, jit, _jitter_rng(seed, ji, 1))
                r = evaluate(pre, post, case, gt_post=measure_ground_truth(gt_post))
            a = r.assertions[0]
            exp_v, exp_reason = EXPECTED.get(case, (None, None))
            ok = exp_v is None or (r.verdict == exp_v and (exp_reason is None or exp_reason in a.reasons))
            rows.append({
                "case": case, "seed": seed, "jitterPx": jit, "precheckOk": pc.ok, "verdict": r.verdict,
                "reasons": list(a.reasons), "expected": exp_v, "expectedReason": exp_reason, "correct": ok,
                "astIdentical": placebo, "values": {k: a.values.get(k) for k in VALUE_KEYS},
                "preRmsMm": r.pre.rmsMm, "preFStarHz": r.pre.fStarHz, "noiseFloorPx": r.noiseFloorPx,
            })
    return rows


def run_suite(out_dir: Path, seeds: tuple[int, ...] = MUTATION_SEEDS, cases: tuple[str, ...] = tuple(EXPECTED),
              jitters: tuple[float, ...] = JITTERS_PX, runner: Runner | None = None, workers: int = 1) -> dict:
    """The full matrix. `runner` must be picklable when workers > 1."""
    n = len(seeds)
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            parts = list(ex.map(run_seed, seeds, [cases] * n, [out_dir] * n, [jitters] * n, [runner] * n))
    else:
        parts = [run_seed(s, cases, out_dir, jitters, runner) for s in seeds]
    rows = [r for p in parts for r in p]
    return {"scenarioId": "s1", "seeds": list(seeds), "cases": list(cases), "jitters": list(jitters),
            "rows": rows, "summary": summarize(rows)}


def _span(vals: list) -> list | None:
    v = [x for x in vals if x is not None]
    return [round(min(v), 3), round(max(v), 3)] if v else None


def summarize(rows: list[dict]) -> list[dict]:
    out = []
    for jit in sorted({r["jitterPx"] for r in rows}):
        for case in sorted({r["case"] for r in rows}):
            sel = [r for r in rows if r["case"] == case and r["jitterPx"] == jit]
            out.append({
                "case": case, "jitterPx": jit, "n": len(sel),
                "pass": sum(r["verdict"] == "PASS" for r in sel),
                "fail": sum(r["verdict"] == "FAIL" for r in sel),
                "correct": sum(r["correct"] for r in sel),
                "precheckBlocked": sum(not r["precheckOk"] for r in sel),
                "reasons": sorted({c for r in sel for c in r["reasons"]}),
                "astIdentical": all(r["astIdentical"] for r in sel),
                **{k: _span([r["values"].get(k) for r in sel]) for k in VALUE_KEYS},
                "aPreMm": _span([r["preRmsMm"] for r in sel]),
            })
    return out


def markdown(report: dict) -> str:
    lines = ["| Jitter px | Case | Expected | PASS | FAIL | Correct | Reasons | aPost mm | Ceiling mm | Drop dB "
             "| Max new peak dB |",
             "| ---: | :--- | :--- | ---: | ---: | ---: | :--- | :--- | :--- | :--- | :--- |"]
    fmt = lambda s: "–" if s is None else f"{s[0]:g} … {s[1]:g}"  # noqa: E731
    for s in report["summary"]:
        exp = EXPECTED.get(s["case"], ("?", None))
        lines.append(f"| {s['jitterPx']:g} | {s['case']} | {exp[0]}{' ' + exp[1] if exp[1] else ''} | {s['pass']} "
                     f"| {s['fail']} | {s['correct']}/{s['n']} | {', '.join(s['reasons']) or '–'} "
                     f"| {fmt(s['aPostMm'])} | {fmt(s['ceilingMm'])} | {fmt(s['dropDb'])} | {fmt(s['maxNewPeakDb'])} |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run the S1 mutation suite through the VUT judge.")
    ap.add_argument("--out", type=Path, default=Path("data/clips/suite"))
    ap.add_argument("--report", type=Path, default=None, help="write the JSON report here")
    ap.add_argument("--seeds", type=int, nargs="*", default=list(MUTATION_SEEDS))
    ap.add_argument("--workers", type=int, default=1)
    a = ap.parse_args(argv)
    rep = run_suite(a.out, tuple(a.seeds), workers=a.workers)
    if a.report:
        a.report.parent.mkdir(parents=True, exist_ok=True)
        a.report.write_text(json.dumps(rep, indent=2), "utf-8")
    print(markdown(rep))
    bad = [r for r in rep["rows"] if not r["correct"]]
    for r in bad:
        print("WRONG", r["case"], r["seed"], r["jitterPx"], r["verdict"], r["reasons"], r["values"])
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
