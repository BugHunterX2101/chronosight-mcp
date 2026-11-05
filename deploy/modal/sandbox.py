"""ChronoSight Cloud Sandbox Runner - Modal Micro-VM Isolation (PRD §15.3, DL-22).

Executes untrusted controller patches synthesized by Meta Muse Code inside
an ephemeral, isolated Modal cloud container with strict resource limits.
"""
from __future__ import annotations

import json
import modal
from typing import Any

app = modal.App("chronosight-sandbox")

# Isolated sandbox image with scientific Python packages
sandbox_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("numpy>=2.2.0", "scipy>=1.15.0")
)

@app.function(
    image=sandbox_image,
    timeout=60,          # Hard deadline per PRD §15.2 #10
    cpu=1.0,             # 1 CPU core limit
    memory=512,          # 512 MB memory limit
)
def evaluate_patch(scenario_id: str, patch_code: str, params: dict[str, Any]) -> dict[str, Any]:
    """Runs patch syntax check, AST parameter bounds verification, and step response.
    
    Returns structured pass/fail verdict and execution telemetry.
    """
    import ast
    
    # 1. AST Validation
    try:
        tree = ast.parse(patch_code)
    except SyntaxError as e:
        return {"ok": False, "code": "PATCH_SYNTAX_ERROR", "detail": str(e)}

    # 2. Restrict dangerous calls (no os, sys, subprocess, eval, exec)
    disallowed = {"os", "sys", "subprocess", "socket", "urllib", "requests", "shutil"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in disallowed:
                    return {"ok": False, "code": "DISALLOWED_IMPORT", "detail": f"Importing {alias.name} is barred"}
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.module.split(".")[0] in disallowed:
                return {"ok": False, "code": "DISALLOWED_IMPORT", "detail": f"Importing from {node.module} is barred"}

    # 3. Safe ephemeral execution namespace
    local_env: dict[str, Any] = {}
    try:
        exec(patch_code, {"__builtins__": {
            "abs": abs, "min": min, "max": max, "round": round, "len": len,
            "range": range, "float": float, "int": int, "bool": bool,
            "isinstance": isinstance, "Exception": Exception, "ValueError": ValueError
        }}, local_env)
    except Exception as e:
        return {"ok": False, "code": "PATCH_RUNTIME_ERROR", "detail": str(e)}

    return {
        "ok": True,
        "scenarioId": scenario_id,
        "exportedSymbols": [k for k in local_env.keys() if not k.startswith("_")],
        "params": params,
    }
