"""Twin internal API (DESIGN §20.6, TECHNICAL §7). Reachable only from the gateway (Z3).

Run: uvicorn twin.app.main:app --host 0.0.0.0 --port 8090
Every path in a body must resolve inside DATA_DIR; nothing else on disk is reachable.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import multiprocessing as mp
import os
import re
import sys
import threading
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..hotload import bounds as hb
from ..hotload import runner as hr
from ..metrics import csmk, sam
from ..metrics.telemetry import Telemetry, Track, assign_refs, measure, measure_ground_truth
from ..render import keyframes as kf
from ..render.encode import ffmpeg_version
from ..render.s1 import RENDERER_VERSION
from ..sim.loader import SCENARIOS, load_baseline
from ..sim.run import load_scenario, render, simulate
from ..vut.evaluate import evaluate, failed_patch_result, precheck

REPO_ROOT = Path(__file__).resolve().parents[4]
# A relative DATA_DIR is taken from the repo root, as the gateway does, so both see one directory.
DATA_DIR = (REPO_ROOT / (os.environ.get("DATA_DIR") or "data")).resolve()
CORPUS_DIR = Path(os.environ.get("CORPUS_DIR", REPO_ROOT / "corpus")).resolve()
SAM_MODEL_ID = os.environ.get("SAM_MODEL_ID", "sam-3.1")
DECODE_WORKERS = int(os.environ.get("TWIN_DECODE_WORKERS", str(max(1, min(4, (os.cpu_count() or 2) - 1)))))
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

_pool: ProcessPoolExecutor | None = None
_render_lock = threading.Lock()              # one render at a time keeps the 8 s budget honest
_tele: OrderedDict[str, Telemetry] = OrderedDict()


def _pool_context():
    """Spawn context for the decode pool. On Windows the workers run under pythonw.exe, so a
    twin started without a console does not open one console window per worker. It must be the
    base interpreter's pythonw: a venv launcher re-spawns it and the worker loses its pipe handle.
    Spawn hands the parent's sys.path to each worker, so venv packages still import."""
    ctx = mp.get_context("spawn")
    if os.name == "nt":
        windowless = Path(getattr(sys, "_base_executable", sys.executable)).with_name("pythonw.exe")
        if windowless.is_file():
            ctx.set_executable(str(windowless))
    return ctx


@asynccontextmanager
async def lifespan(_: FastAPI):
    global _pool
    for d in ("clips", "masks", "patches", "work", "cache"):
        (DATA_DIR / d).mkdir(parents=True, exist_ok=True)
    _pool = ProcessPoolExecutor(max_workers=DECODE_WORKERS, mp_context=_pool_context())
    try:
        yield
    finally:
        _pool.shutdown(cancel_futures=True)


app = FastAPI(title="ChronoSight twin", version="1", lifespan=lifespan, docs_url=None, redoc_url=None)


class _B(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RenderBody(_B):
    scenarioId: str = "s1"
    seed: int = Field(ge=0, le=2**31 - 1)
    controller: str = "baseline"
    durationS: float | None = Field(default=None, gt=0, le=10)
    clipId: str | None = None


class ByoScale(_B):
    """A person's clip, not a render (PRD L2). The scenario still supplies the concept plan; the camera does not apply,
    so the scale is what the person entered, or comes from the marker's known size, or is unknown (FR-MEA-2)."""
    mmPerPx: float | None = Field(default=None, gt=0, le=1000)
    markerSizeMm: float | None = Field(default=None, gt=0, le=1000)


class MetricsBody(_B):
    clipId: str
    csmkPath: str
    scenarioId: str = "s1"
    phase: str = "pre"
    # 60 s at 30 fps is 1800 frames (FR-CAP-4); a scenario render stays at its own 5 s.
    nFrames: int | None = Field(default=None, gt=0, le=1800)
    byo: ByoScale | None = None
    groundTruthPath: str | None = None
    includeSpectrum: bool = True


class KeyFramesBody(_B):
    clipId: str
    scenarioId: str = "s1"
    clipPath: str
    csmkPath: str
    nFrames: int | None = Field(default=None, gt=0, le=1800)
    byo: ByoScale | None = None


class ClipRef(_B):
    clipId: str
    csmkPath: str | None = None
    nFrames: int | None = None
    groundTruthPath: str | None = None


class Failure(_B):
    code: str
    detail: str = ""


class VisualTestBody(_B):
    scenarioId: str = "s1"
    patchId: str
    pre: ClipRef
    post: ClipRef | None = None
    failure: Failure | None = None
    objectId: int | None = None
    testId: str | None = None


class SamSource(_B):
    ssePath: str
    conceptIdx: int = Field(ge=0, le=255)


class SamIngestBody(_B):
    clipId: str
    scenarioId: str = "s1"
    sources: list[SamSource] = Field(min_length=1, max_length=16)
    fps: float | None = Field(default=None, gt=0, le=240)
    # A real clip has its own frame size; a scenario render takes the camera's.
    width: int | None = Field(default=None, ge=16, le=4096)
    height: int | None = Field(default=None, ge=16, le=4096)

    @model_validator(mode="after")
    def _both_or_neither(self):
        if (self.width is None) != (self.height is None):
            raise ValueError("width and height go together")
        return self


class PatchLoadBody(_B):
    scenarioId: str = "s1"
    patchId: str
    files: dict[str, str] = {}
    dryRun: bool = False
    specBounds: dict[str, list[float]] | None = None


def _err(status: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"code": code, "message": message, **extra})


def _inside(p: str | Path) -> Path:
    path = Path(p)
    path = (path if path.is_absolute() else DATA_DIR / path).resolve()
    if path != DATA_DIR and DATA_DIR not in path.parents:
        raise HTTPException(400, detail={"code": "PATH_OUTSIDE_DATA_DIR", "message": str(p)})
    return path


def _scenario(scenario_id: str) -> dict:
    if not ID_RE.match(scenario_id) or not (SCENARIOS / scenario_id / "scenario.yaml").is_file():
        raise HTTPException(404, detail={"code": "SCENARIO_UNKNOWN", "message": scenario_id})
    return load_scenario(scenario_id)


def _baseline_files(scenario_id: str) -> dict[str, str]:
    base = SCENARIOS / scenario_id / "baseline"
    return {n: (base / n).read_text(encoding="utf-8") for n in ("controller.py", "params.py")}


def _sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def baseline_cache_key(scenario_id: str, seed: int, duration_s: float) -> str:
    """DESIGN §20.5: (scenarioId, scenarioVersion, seed, baselineControllerHash, rendererVersion,
    samConceptsHash, samModelId). Duration is part of the clip, so it joins the key."""
    sc = load_scenario(scenario_id)
    return _sha([scenario_id, sc["version"], seed, _sha(_baseline_files(scenario_id)), RENDERER_VERSION,
                 _sha(sc["concepts"]), SAM_MODEL_ID, duration_s])[:32]


def _cache_index() -> dict:
    p = DATA_DIR / "cache" / "baseline-index.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.is_file() else {}


def _cache_put(key: str, val: dict) -> None:
    idx = _cache_index()
    idx[key] = val
    p = DATA_DIR / "cache" / "baseline-index.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, indent=1), encoding="utf-8")
    os.replace(tmp, p)


# ---------------------------------------------------------------- health

@app.get("/healthz")
def healthz() -> dict:
    try:
        ff = ffmpeg_version()
    except Exception as exc:  # noqa: BLE001
        ff = f"unavailable: {exc}"
    return {"ok": True, "renderer": RENDERER_VERSION, "ffmpeg": ff, "samModelId": SAM_MODEL_ID}


@app.get("/readyz")
def readyz():
    checks: dict[str, Any] = {}
    try:
        checks["scenarios"] = sorted(p.name for p in SCENARIOS.iterdir() if (p / "scenario.yaml").is_file())
        for s in checks["scenarios"]:
            load_scenario(s)
        checks["scenariosOk"] = bool(checks["scenarios"])
    except Exception as exc:  # noqa: BLE001
        checks["scenariosOk"], checks["scenarioError"] = False, str(exc)
    try:
        _cache_index()
        checks["baselineCacheOk"] = True
    except Exception:  # noqa: BLE001
        checks["baselineCacheOk"] = False
    checks["corpusOk"] = (CORPUS_DIR / "encx14" / "manifest.json").is_file()
    ok = checks.get("scenariosOk") and checks["baselineCacheOk"] and checks["corpusOk"]
    return JSONResponse(status_code=200 if ok else 503, content={"ok": bool(ok), **checks})


# ---------------------------------------------------------------- render

def _patch_dir(patch_id: str) -> Path:
    if not ID_RE.match(patch_id):
        raise HTTPException(400, detail={"code": "BAD_PATCH_ID", "message": patch_id})
    return DATA_DIR / "patches" / patch_id


@app.post("/render")
def render_clip(body: RenderBody):
    sc = _scenario(body.scenarioId)
    dur = float(body.durationS or sc["durationS"])
    out_dir = DATA_DIR / "clips"
    if body.controller == "baseline":
        key = baseline_cache_key(body.scenarioId, body.seed, dur)
        hit = _cache_index().get(key)
        if hit and Path(hit["clipPath"]).is_file() and Path(hit["groundTruthPath"]).is_file():
            return {**hit, "cached": True, "cacheKey": key}
        controller, params = load_baseline(body.scenarioId)
        trace = simulate(body.scenarioId, controller, body.seed, dur)
        if trace.error:
            return _err(500, "BASELINE_FAILED", trace.error)
        name = body.clipId or f"{body.scenarioId}-baseline-{body.seed}-{key[:8]}"
        with _render_lock:
            res = render(body.scenarioId, trace, body.seed, out_dir, name, dur,
                         meta={"scenarioId": body.scenarioId, "seed": body.seed, "controller": "baseline",
                               "params": params})
        _cache_put(key, res)
        return {**res, "cached": False, "cacheKey": key}

    pdir = _patch_dir(body.controller)
    files_dir = pdir / "files"
    if not files_dir.is_dir():
        return _err(404, "PATCH_NOT_LOADED", f"call /patch/load for {body.controller} first")
    files = {p.name: p.read_text(encoding="utf-8") for p in files_dir.iterdir() if p.is_file()}
    full = {**_baseline_files(body.scenarioId), **files}
    workdir = hr.stage(DATA_DIR / "work" / body.controller, full,
                       SCENARIOS / body.scenarioId / "baseline" / "abi.py")
    trace, failure = hr.simulate_patch(lambda ctl: simulate(body.scenarioId, ctl, body.seed, dur), workdir)
    if failure is not None:
        return JSONResponse(status_code=422, content=failure.as_dict())
    name = body.clipId or f"{body.scenarioId}-{body.controller}-{body.seed}"
    with _render_lock:
        res = render(body.scenarioId, trace, body.seed, out_dir, name, dur,
                     meta={"scenarioId": body.scenarioId, "seed": body.seed, "controller": body.controller})
    return {**res, "cached": False}


# ---------------------------------------------------------------- metrics

def _remember(clip_id: str, t: Telemetry) -> None:
    _tele[clip_id] = t
    _tele.move_to_end(clip_id)
    while len(_tele) > 64:
        _tele.popitem(last=False)


def _measure_csmk(scenario_id: str, path: Path, n_frames: int | None, byo: ByoScale | None = None) -> Telemetry:
    sc = load_scenario(scenario_id)
    header, recs = csmk.read(path)
    fps = float(header.fps or sc["fps"])
    n = n_frames or int(round(fps * sc["durationS"]))
    dec = _decoded(path, recs)
    if byo is None:
        return sam.telemetry(recs, sc["concepts"], fps, sc["camera"]["mmPerPx"], n, lambda _f, _xs: dec)
    return sam.telemetry(recs, sc["concepts"], fps, byo.mmPerPx, n, lambda _f, _xs: dec,
                         marker_mm=byo.markerSizeMm, scale_source="user")


def _decoded(path: Path, recs: list[csmk.CsmkRecord]) -> list[tuple[float, float, float]]:
    """`sam.decode` of every record, in record order. The official decoder dominates the cost
    (about 0.1 s per mask), so the result is kept beside the .csmk, bound to its sha256, and
    written at ingest (PERCEIVING) so that MEASURING stays within its 10 s (DESIGN §8.1)."""
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    side = path.with_name(path.name + ".dec.npz")
    if side.is_file():
        try:
            with np.load(side) as z:
                if str(z["sha256"]) == sha and z["dec"].shape == (len(recs), 3):
                    return [(float(a), float(b), float(c)) for a, b, c in z["dec"]]
        except (OSError, ValueError, KeyError):
            pass  # unreadable or stale: decode again and overwrite
    pool = _pool
    it = pool.map(sam.decode, recs, chunksize=16) if pool is not None else map(sam.decode, recs)
    dec = np.asarray(list(it), dtype=np.float64).reshape(len(recs), 3)
    tmp = path.with_name(path.name + ".dec.tmp.npz")
    np.savez(tmp, dec=dec, sha256=np.array(sha))
    os.replace(tmp, side)
    return [(float(a), float(b), float(c)) for a, b, c in dec]


def _num(v: float | None) -> float | None:
    return None if v is None or not np.isfinite(v) else round(float(v), 6)


def summary(t: Telemetry, spectrum: bool = True) -> dict:
    out: dict[str, Any] = {
        "rmsPx": _num(t.a_px), "rmsMm": _num(t.a_mm), "p2pPx": _num(t.p2p_px), "fStarHz": _num(t.f_star_hz),
        "coverage": {k: round(v, 6) for k, v in t.coverage.items()}, "confMean": _num(t.conf_mean),
        "areaMedianPx": _num(t.area_median), "noiseFloorPx": _num(t.n0_px), "fps": t.fps,
        "frames": t.n_frames, "mmPerPx": _num(t.scale_mm_per_px), "scaleSource": t.scale_source, "warnings": list(t.warnings),
    }
    if spectrum:
        floor = t.floor_on(t.grid)
        out["spectrum"] = {"f": [round(float(x), 4) for x in t.grid],
                           "s": [_num(x) for x in t.spec],
                           "n0": [_num(x) for x in floor]}
    return out


def _assert_params(sc: dict) -> dict:
    for a in sc.get("assertions", []):
        if a.get("type") == "vibration":
            return dict(a.get("params") or {})
    return {}


@app.post("/metrics")
async def metrics(body: MetricsBody):
    sc = _scenario(body.scenarioId)
    path = _inside(body.csmkPath)
    if not path.is_file():
        return _err(404, "CSMK_NOT_FOUND", body.csmkPath)
    try:
        t = await asyncio.to_thread(_measure_csmk, body.scenarioId, path, body.nFrames, body.byo)
    except csmk.CsmkError as exc:
        return _err(422, "CSMK_INVALID", str(exc))
    _remember(body.clipId, t)
    pc = precheck(t, coverage_min=_assert_params(sc).get("coverageMin", 0.90))
    out = {"clipId": body.clipId, "phase": body.phase, "scenarioId": body.scenarioId,
           **summary(t, body.includeSpectrum), "precheck": pc.model_dump(mode="json")}
    if body.groundTruthPath:
        gt = json.loads(_inside(body.groundTruthPath).read_text(encoding="utf-8"))
        g = measure_ground_truth(gt)
        out["groundTruth"] = {"rmsMmTrue": _num(g.a_mm), "fStarHzTrue": _num(g.f_star_hz),
                              "trueAmplitudeMm": gt.get("trueAmplitudeMm"), "trueFStarHz": gt.get("trueFStarHz")}
    return out


def _key_frames(body: KeyFramesBody, sc: dict, clip: Path, path: Path) -> list[dict]:
    t = _tele.get(body.clipId) or _measure_csmk(body.scenarioId, path, body.nFrames, body.byo)
    _remember(body.clipId, t)
    return kf.render(clip, csmk.read(path)[1], sc["concepts"], t)


@app.post("/keyframes")
async def key_frames(body: KeyFramesBody):
    """D3 (DESIGN §16.1): 2–4 frames of a clip with the mask outlines drawn, 768 px long edge, JPEG."""
    sc = _scenario(body.scenarioId)
    clip, path = _inside(body.clipPath), _inside(body.csmkPath)
    if not clip.is_file():
        return _err(404, "CLIP_NOT_FOUND", body.clipPath)
    if not path.is_file():
        return _err(404, "CSMK_NOT_FOUND", body.csmkPath)
    try:
        frames = await asyncio.to_thread(_key_frames, body, sc, clip, path)
    except (kf.KeyFrameError, csmk.CsmkError) as exc:
        return _err(422, "KEYFRAMES_UNAVAILABLE", str(exc))
    return {"clipId": body.clipId, "frames": frames}


def _ingest(body: SamIngestBody, sc: dict) -> dict:
    recs: list[csmk.CsmkRecord] = []
    objects: dict[str, list[int]] = {}
    usage: dict[str, dict] = {}
    warnings: list[str] = []
    for src in body.sources:
        if src.conceptIdx >= len(sc["concepts"]):
            raise HTTPException(400, detail={"code": "CONCEPT_UNKNOWN", "message": str(src.conceptIdx)})
        path = _inside(src.ssePath)
        if not path.is_file():
            raise HTTPException(404, detail={"code": "SSE_NOT_FOUND", "message": src.ssePath})
        try:
            got, use = sam.records_from_sse(path, src.conceptIdx)
        except sam.SamFormatError as exc:
            raise HTTPException(422, detail={"code": "SAM_FORMAT", "message": f"{src.ssePath}: {exc}"}) from exc
        recs += got
        ids = sorted({r.object_id for r in got})
        concept = sc["concepts"][src.conceptIdx]
        objects[concept["slug"]] = ids
        usage[concept["slug"]] = use
        if len(ids) > int(concept.get("expectedCount", 1)):
            # §12.6 SAM_AMBIGUOUS: measurement keeps the longest tracks up to the expected count.
            warnings.append(f"SAM_AMBIGUOUS: {concept['slug']} returned {len(ids)} objects, "
                            f"expected {concept.get('expectedCount', 1)}")
    # Frame-major order keeps the .idx a per-frame slice; within a frame, concept then object (§12.3).
    recs.sort(key=lambda r: (r.frame_idx, r.concept_idx, r.object_id))
    cam = sc["camera"]
    header = sam.header_for(recs, int(body.width or cam["width"]), int(body.height or cam["height"]), float(body.fps or sc["fps"]))
    out = DATA_DIR / "masks" / f"{body.clipId}.csmk"
    csmk.write(out, header, recs)
    _decoded(out, csmk.read(out)[1])
    return {"clipId": body.clipId, "csmkPath": out.relative_to(DATA_DIR).as_posix(), "records": len(recs),
            "flags": header.flags, "objects": objects, "usage": usage, "warnings": warnings}


@app.post("/sam/ingest")
async def sam_ingest(body: SamIngestBody):
    """Teed SAM streams (DESIGN §12.4) for one clip -> masks/<clipId>.csmk + .idx (§10)."""
    if not ID_RE.match(body.clipId):
        return _err(400, "BAD_CLIP_ID", body.clipId)
    sc = _scenario(body.scenarioId)
    return await asyncio.to_thread(_ingest, body, sc)


STREAM_EVERY = 15


@app.post("/metrics/stream")
async def metrics_stream(request: Request, scenarioId: str = "s1", nFrames: int | None = None):
    """NDJSON in: one line per object per frame, either placed (`cx`,`cy`,`area`) or raw
    (`box`,`mask` = SAM "H,W,~data"). NDJSON out: rolling metrics every 15 frames, then final."""
    sc = _scenario(scenarioId)
    fps = float(sc["fps"])
    n_total = nFrames or int(round(fps * sc["durationS"]))
    roles = {i: c["role"] for i, c in enumerate(sc["concepts"])}
    loop = asyncio.get_running_loop()

    async def gen():
        per: dict[tuple[int, int], list[dict]] = {}
        last_emit, max_frame, buf = -1, -1, b""

        def rolling(final: bool) -> dict:
            fault = [Track.from_records(v) for (ci, _), v in per.items() if roles.get(ci) == "fault"]
            refs = [Track.from_records(v) for (ci, _), v in per.items() if roles.get(ci) == "refs"]
            fault_t = max(fault, key=len) if fault else Track.empty()
            ra, rb = assign_refs(sorted(refs, key=len, reverse=True)[:2])
            seen = n_total if final else max_frame + 1
            t = measure(fault_t, ra, rb, fps, sc["camera"]["mmPerPx"], max(seen, 1))
            return {"type": "final" if final else "rolling", "frame": max_frame, **summary(t, spectrum=final)}

        async for chunk in request.stream():
            buf += chunk
            *lines, buf = buf.split(b"\n")
            for ln in lines:
                if not ln.strip():
                    continue
                o = json.loads(ln)
                if "cx" not in o:
                    rec = csmk.CsmkRecord(int(o["frame"]), int(o["conceptIdx"]), int(o.get("objectId", 0)),
                                          tuple(float(x) for x in o["box"]), float(o.get("conf", 1.0)),
                                          o["mask"].encode("ascii"))
                    cx, cy, area = await loop.run_in_executor(_pool, sam.decode, rec)
                    o = {**o, "cx": cx, "cy": cy, "area": area}
                if not o.get("area"):
                    continue
                key = (int(o["conceptIdx"]), int(o.get("objectId", 0)))
                per.setdefault(key, []).append({"frame": int(o["frame"]), "cx": o["cx"], "cy": o["cy"],
                                                "area": o["area"], "conf": float(o.get("conf", 1.0))})
                max_frame = max(max_frame, int(o["frame"]))
                if max_frame - last_emit >= STREAM_EVERY:
                    last_emit = max_frame
                    yield (json.dumps(rolling(False)) + "\n").encode()
        yield (json.dumps(rolling(True)) + "\n").encode()

    return StreamingResponse(gen(), media_type="application/x-ndjson")


# ---------------------------------------------------------------- visual test

async def _telemetry_for(scenario_id: str, ref: ClipRef) -> Telemetry:
    if ref.clipId in _tele:
        return _tele[ref.clipId]
    if not ref.csmkPath:
        raise HTTPException(409, detail={"code": "TELEMETRY_UNKNOWN",
                                         "message": f"no telemetry for {ref.clipId}; call /metrics or send csmkPath"})
    t = await asyncio.to_thread(_measure_csmk, scenario_id, _inside(ref.csmkPath), ref.nFrames)
    _remember(ref.clipId, t)
    return t


@app.post("/visual-test")
async def visual_test(body: VisualTestBody):
    sc = _scenario(body.scenarioId)
    params = _assert_params(sc)
    pre = await _telemetry_for(body.scenarioId, body.pre)
    if body.post is None:
        f = body.failure or Failure(code="PATCH_RUNTIME_ERROR", detail="no post clip")
        res = failed_patch_result(pre, body.patchId, f.code, f.detail, object_id=body.objectId, test_id=body.testId)
        return res.dump()
    post = await _telemetry_for(body.scenarioId, body.post)
    gt_post = None
    if body.post.groundTruthPath:
        gt_post = measure_ground_truth(json.loads(_inside(body.post.groundTruthPath).read_text(encoding="utf-8")))
    res = evaluate(pre, post, body.patchId, params, object_id=body.objectId, gt_post=gt_post, test_id=body.testId)
    return res.dump()


# ---------------------------------------------------------------- patch load

@app.post("/patch/load")
def patch_load(body: PatchLoadBody):
    sc = _scenario(body.scenarioId)
    pdir = _patch_dir(body.patchId)
    base = _baseline_files(body.scenarioId)
    if body.patchId == "placebo":
        files = body.files or hb.make_placebo(base)
        if not hb.placebo_identical({**base, **files}, base):
            return _err(422, "PLACEBO_AST_MISMATCH", "placebo AST differs from the baseline; child run aborted")
        result: dict[str, Any] = {"ok": True, "code": None, "details": [], "params": None,
                                  "approvalExempt": "placebo-ast-identical"}
    else:
        files = body.files
        result = hb.bounds_check(files, sc["targetFiles"], sc["hardBounds"], body.specBounds, base)
    if body.dryRun:
        return result
    if not result["ok"]:
        return JSONResponse(status_code=422, content=result)
    workdir = hr.stage(DATA_DIR / "work" / body.patchId, {**base, **files},
                       SCENARIOS / body.scenarioId / "baseline" / "abi.py")
    try:
        hr.RemoteController(workdir).close()          # import + init handshake only
    except hr.PatchRuntimeError as exc:
        return JSONResponse(status_code=422, content=exc.failure.as_dict())
    fdir = pdir / "files"
    fdir.mkdir(parents=True, exist_ok=True)
    for old in fdir.iterdir():
        old.unlink()
    for name, text in files.items():
        (fdir / name).write_text(text, encoding="utf-8", newline="\n")
    (pdir / "meta.json").write_text(json.dumps({"patchId": body.patchId, "scenarioId": body.scenarioId,
                                                "filesSha256": _sha(files), "bounds": result}), encoding="utf-8")
    return {"ok": True, "patchId": body.patchId, "params": result.get("params"),
            "approvalExempt": result.get("approvalExempt")}
