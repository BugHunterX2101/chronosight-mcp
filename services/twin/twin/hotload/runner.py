"""Parent side of the patch hot-load (DESIGN §20.4, TECHNICAL §6.11).

`RemoteController` looks like an in-process controller to the plant, but every `step`
is a msgpack round trip to a `python -I` child that holds only the candidate's files.
"""
from __future__ import annotations

import math
import queue
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import msgpack

from ..scenarios.s1.baseline.abi import REG_CONF2, Command

CHILD = Path(__file__).resolve().with_name("child.py")
MAX_FRAME = 64 * 1024
STEP_TIMEOUT_S = 0.050
INIT_TIMEOUT_S = 5.0
SIM_TIMEOUT_S = 15.0
TB_MAX = 2048
DOCUMENTED_REGS = {REG_CONF2}


@dataclass
class PatchFailure:
    reason: str               # crash | hang | invalid_command
    detail: str
    traceback: str = ""

    def as_dict(self) -> dict:
        return {"code": "PATCH_RUNTIME_ERROR", "reason": self.reason, "detail": self.detail,
                "traceback": self.traceback}


class PatchRuntimeError(RuntimeError):
    def __init__(self, failure: PatchFailure) -> None:
        super().__init__(f"{failure.reason}: {failure.detail}")
        self.failure = failure


def sanitize_tb(tb: str) -> str:
    """Rewrite paths to <file>:<line> and cap at 2 KB (it becomes D5 evidence)."""
    tb = re.sub(r'File "[^"]*[\\/]([^"\\/]+)", line (\d+)', r"\1:\2", tb)
    return tb[-TB_MAX:]


class RemoteController:
    def __init__(self, workdir: Path, params: dict | None = None) -> None:
        self.failure: PatchFailure | None = None
        self._t0 = time.monotonic()
        workdir = Path(workdir).resolve()
        self._proc = subprocess.Popen([sys.executable, "-I", str(CHILD), str(workdir)],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      cwd=str(workdir))
        self._q: queue.Queue = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        self._call({"t": "init", "params": params or {}}, INIT_TIMEOUT_S, expect="ready")

    def _reader(self) -> None:
        out = self._proc.stdout
        assert out is not None
        try:
            while True:
                head = out.read(4)
                if len(head) < 4:
                    break
                (n,) = struct.unpack(">I", head)
                if n > MAX_FRAME:
                    self._q.put({"t": "err", "type": "ProtocolError", "msg": "frame too large", "tb": ""})
                    break
                self._q.put(msgpack.unpackb(out.read(n), raw=False))
        finally:
            self._q.put(None)

    def _fail(self, reason: str, detail: str, tb: str = "") -> PatchRuntimeError:
        if self.failure is None:
            self.failure = PatchFailure(reason, detail, sanitize_tb(tb))
        self.close()
        return PatchRuntimeError(self.failure)

    def _call(self, msg: dict, timeout: float, expect: str) -> dict:
        if self.failure is not None:
            raise PatchRuntimeError(self.failure)
        if time.monotonic() - self._t0 > SIM_TIMEOUT_S:
            raise self._fail("hang", f"simulation exceeded {SIM_TIMEOUT_S:.0f} s")
        body = msgpack.packb(msg, use_bin_type=True)
        try:
            assert self._proc.stdin is not None
            self._proc.stdin.write(struct.pack(">I", len(body)) + body)
            self._proc.stdin.flush()
        except OSError:
            pass                                    # the reader reports what happened
        try:
            rep = self._q.get(timeout=timeout)
        except queue.Empty:
            raise self._fail("hang", f"no answer within {timeout * 1000:.0f} ms") from None
        if rep is None:
            raise self._fail("crash", f"child exited with code {self._proc.poll()}")
        if rep.get("t") == "err":
            raise self._fail("crash", f"{rep.get('type')}: {rep.get('msg')}", rep.get("tb", ""))
        if rep.get("t") != expect:
            raise self._fail("invalid_command", f"expected {expect}, got {rep.get('t')!r}")
        return rep

    def step(self, state, dt: float) -> Command:
        st = [state.t, state.q_meas, state.q_ref, state.qd_ref, state.enc_raw, state.enc_status]
        rep = self._call({"t": "step", "state": st, "dt": dt}, STEP_TIMEOUT_S, expect="cmd")
        u = rep.get("u")
        if not isinstance(u, (int, float)) or not math.isfinite(u) or abs(u) > 1.0:
            raise self._fail("invalid_command", f"u={u!r} at t={state.t:.3f}s")
        writes = rep.get("regWrites") or []
        for w in writes:
            if not (isinstance(w, list) and len(w) == 2 and w[0] in DOCUMENTED_REGS and 0 <= int(w[1]) <= 0xFF):
                raise self._fail("invalid_command", f"register write {w!r} at t={state.t:.3f}s")
        return Command(u=float(u), reg_writes=[(int(a), int(v)) for a, v in writes])

    def close(self) -> None:
        p = self._proc
        if p.poll() is None:
            try:
                if p.stdin:
                    p.stdin.close()
                p.wait(timeout=0.5)
            except Exception:  # noqa: BLE001
                p.kill()
                p.wait()


def stage(workdir: Path, files: dict[str, str], abi_path: Path) -> Path:
    """Write the candidate's files plus a copy of the scenario ABI, read-only."""
    workdir = Path(workdir)
    if workdir.exists():
        for p in workdir.iterdir():
            p.chmod(0o600)
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    for name, text in {**files, "abi.py": abi_path.read_text(encoding="utf-8")}.items():
        p = workdir / name
        p.write_text(text, encoding="utf-8", newline="\n")
        p.chmod(0o444)
    return workdir


def simulate_patch(simulate_fn, workdir: Path):
    """Run `simulate_fn(controller)` against the child. Returns (trace, failure)."""
    ctl = None
    try:
        ctl = RemoteController(workdir)
        trace = simulate_fn(ctl)
    except PatchRuntimeError as exc:
        return None, exc.failure
    finally:
        if ctl is not None:
            ctl.close()
    if ctl.failure is not None:
        return None, ctl.failure
    if trace.error:
        return None, PatchFailure("invalid_command", trace.error)
    return trace, None
