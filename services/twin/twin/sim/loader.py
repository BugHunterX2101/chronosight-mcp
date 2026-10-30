"""Load a controller package (controller.py + params.py) from a directory, in process.

Used for the baseline and for tests. Untrusted patches never come through here:
they run in a child process via `twin.hotload`.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

SCENARIOS = Path(__file__).resolve().parent.parent / "scenarios"


def _load_module(name: str, path: Path) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_controller(pkg_dir: Path, abi_path: Path, params_override: dict | None = None):
    """Import `controller.py` with the scenario's `abi` visible as a top-level module."""
    pkg_dir = Path(pkg_dir)
    abi = _load_module("abi", abi_path)
    saved = sys.modules.get("abi")
    sys.modules["abi"] = abi
    try:
        params_mod = _load_module(f"_cs_params_{id(pkg_dir)}", pkg_dir / "params.py")
        ctrl_mod = _load_module(f"_cs_controller_{id(pkg_dir)}", pkg_dir / "controller.py")
    finally:
        if saved is None:
            sys.modules.pop("abi", None)
        else:
            sys.modules["abi"] = saved
    params = dict(params_mod.PARAMS)
    if params_override:
        params.update(params_override)
    return ctrl_mod.Controller(params), params


def load_baseline(scenario_id: str = "s1", params_override: dict | None = None):
    base = SCENARIOS / scenario_id / "baseline"
    return load_controller(base, base / "abi.py", params_override)
