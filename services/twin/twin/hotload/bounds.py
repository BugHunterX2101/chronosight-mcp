"""Static bounds check (DESIGN §17.4, TECHNICAL §6.5) and the placebo AST identity (§8.3).

Runs before any simulation. `ast` is the authoritative Python parser, which is why the
gateway asks the twin (`/patch/load` with dryRun) instead of checking Python itself.
"""
from __future__ import annotations

import ast
import difflib
import math

ALLOWED_IMPORTS = {"math", "dataclasses", "typing", "collections", "numpy", "abi"}
BANNED_NAMES = {"os", "sys", "subprocess", "socket", "importlib", "open", "eval", "exec", "compile",
                "__import__", "globals", "locals", "vars", "getattr", "setattr", "delattr", "input",
                "breakpoint", "__builtins__"}
MAX_DIFF_LINES = 400


def _params_literal(src: str) -> tuple[dict | None, str | None]:
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return None, f"params.py: syntax error at line {exc.lineno}"
    body = [n for n in tree.body if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant))]
    if len(body) != 1 or not isinstance(body[0], ast.Assign) or len(body[0].targets) != 1 \
            or not isinstance(body[0].targets[0], ast.Name) or body[0].targets[0].id != "PARAMS":
        return None, "params.py must contain exactly one assignment: PARAMS = {...}"
    try:
        val = ast.literal_eval(body[0].value)
    except ValueError:
        return None, "PARAMS must be a dict of number literals"
    if not isinstance(val, dict) or not all(isinstance(k, str) for k in val):
        return None, "PARAMS must be a dict with string keys"
    for k, v in val.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            return None, f"PARAMS[{k!r}] is not a finite number"
    return val, None


def _imports(src: str) -> list[str]:
    try:
        tree = ast.parse(src)
    except SyntaxError as exc:
        return [f"controller.py: syntax error at line {exc.lineno}"]
    bad: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            bad += [f"import {a.name}" for a in node.names if a.name.split(".")[0] not in ALLOWED_IMPORTS]
        elif isinstance(node, ast.ImportFrom):
            if node.level or (node.module or "").split(".")[0] not in ALLOWED_IMPORTS:
                bad.append(f"from {'.' * node.level}{node.module or ''} import ...")
        elif isinstance(node, ast.Name) and node.id in BANNED_NAMES:
            bad.append(f"name {node.id}")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("__") and node.attr != "__init__":
            bad.append(f"attribute {node.attr}")
    return sorted(set(bad))


def _intersect(hard: list[float], spec: list[float] | None) -> tuple[float, float]:
    lo, hi = float(hard[0]), float(hard[1])
    if spec:
        lo, hi = max(lo, float(spec[0])), min(hi, float(spec[1]))
    return lo, hi


def diff_lines(files: dict[str, str], baseline: dict[str, str]) -> int:
    n = 0
    for name in set(files) | set(baseline):
        a, b = baseline.get(name, "").splitlines(), files.get(name, "").splitlines()
        n += sum(1 for ln in difflib.unified_diff(a, b, lineterm="", n=0)
                 if ln[:1] in "+-" and not ln.startswith(("+++", "---")))
    return n


def bounds_check(files: dict[str, str], target_files: list[str], hard_bounds: dict[str, list[float]],
                 spec_bounds: dict[str, list[float]] | None = None,
                 baseline: dict[str, str] | None = None) -> dict:
    """{ok, code, details[], params}; code is PATCH_BOUNDS_VIOLATION when not ok."""
    details: list[dict] = []
    extra = sorted(set(files) - set(target_files))
    if extra:
        details.append({"check": "paths", "message": f"files outside targetFiles: {', '.join(extra)}"})
    params = None
    if "params.py" in files:
        params, err = _params_literal(files["params.py"])
        if err:
            details.append({"check": "literals", "message": err})
    elif baseline and "params.py" in baseline:
        params, _ = _params_literal(baseline["params.py"])
    for k, v in (params or {}).items():
        if k not in hard_bounds:
            details.append({"check": "ranges", "param": k, "message": f"{k} has no hard bound"})
            continue
        lo, hi = _intersect(hard_bounds[k], (spec_bounds or {}).get(k))
        if not lo <= v <= hi:
            details.append({"check": "ranges", "param": k, "value": v, "min": lo, "max": hi,
                            "message": f"{k}={v} outside [{lo}, {hi}]"})
    if "controller.py" in files:
        for b in _imports(files["controller.py"]):
            details.append({"check": "imports", "message": b})
    if baseline is not None:
        n = diff_lines(files, {k: baseline.get(k, "") for k in files})
        if n > MAX_DIFF_LINES:
            details.append({"check": "size", "value": n, "max": MAX_DIFF_LINES,
                            "message": f"diff is {n} lines (max {MAX_DIFF_LINES})"})
    ok = not details
    return {"ok": ok, "code": None if ok else "PATCH_BOUNDS_VIOLATION", "details": details, "params": params}


def placebo_identical(files: dict[str, str], baseline: dict[str, str]) -> bool:
    """ast.dump equality for every baseline Python file (whitespace-only changes pass)."""
    try:
        return all(ast.dump(ast.parse(files.get(name, ""))) == ast.dump(ast.parse(src))
                   for name, src in baseline.items() if name.endswith(".py"))
    except SyntaxError:
        return False


def make_placebo(baseline: dict[str, str]) -> dict[str, str]:
    """The baseline with a whitespace-only change (trailing blank line on controller.py)."""
    return {k: (v + "\n" if k == "controller.py" else v) for k, v in baseline.items()}
