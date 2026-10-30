"""S1 physics: one elbow joint, the EncoderX-14 encoder model and the 1 kHz loop.

Semi-implicit Euler at 1 kHz (DESIGN §20.3). Every noise source draws from its own
PCG64 child generator, so adding a source never shifts the others.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .baseline.abi import REG_CONF2, STATUS_RST, State

LSB = 2.0 * math.pi / 16384.0     # 14-bit absolute encoder


@dataclass(frozen=True)
class PlantParams:
    inertia: float = 0.02         # kg·m², forearm about the elbow
    viscous: float = 0.01         # N·m·s/rad
    torque_max: float = 4.0       # N·m at duty 1.0
    read_delay_ms: int = 2        # I2C read latency (manual p. 12)
    noise_lsb: float = 12.0       # raw read noise with FILT = 0 (manual p. 31, table 31-2)
    adc_rate_hz: float = 8000.0   # internal sampling rate the FILT IIR runs at


class EncoderX14:
    """Behavioural model of the EncoderX-14 (corpus/encx14, pp. 31 and 58)."""

    def __init__(self, rng: np.random.Generator, p: PlantParams) -> None:
        self.rng = rng
        self.p = p
        self.regs = {REG_CONF2: 0}
        self.status = 0
        self._lag = None

    def reset(self) -> None:
        # Errata E-3 (p. 58): every reset clears CONF2, so FILT returns to 0 (off).
        self.regs[REG_CONF2] = 0
        self.status |= STATUS_RST
        self._lag = None

    def write(self, addr: int, value: int) -> None:
        if addr == REG_CONF2:
            self.regs[REG_CONF2] = int(value) & 0xFF

    @property
    def filt(self) -> int:
        return self.regs[REG_CONF2] & 0x07

    def read(self, q_true: float, dt: float) -> tuple[float, int, int]:
        n = self.filt
        if n:
            alpha = 2.0 ** -n
            tau = (2 ** n) / self.p.adc_rate_hz
            gain = math.sqrt(alpha / (2.0 - alpha))       # IIR noise reduction (p. 31)
            if self._lag is None:
                self._lag = q_true
            self._lag += (1.0 - math.exp(-dt / tau)) * (q_true - self._lag)
            q_seen = self._lag
        else:
            gain = 1.0
            q_seen = q_true
        code = int(round(q_seen / LSB + self.rng.normal(0.0, self.p.noise_lsb * gain)))
        raw = code % 16384
        status = self.status
        self.status = 0                                   # a read clears the sticky flags
        return code * LSB, raw, status


@dataclass
class SimTrace:
    dt: float
    t: np.ndarray            # s from the start of the clip (negative during warm-up)
    q: np.ndarray            # true joint angle, rad
    q_ref: np.ndarray
    u: np.ndarray
    filt: np.ndarray         # FILT value in force after each step
    error: str | None = None


def simulate(controller, seed_seq: np.random.SeedSequence, duration_s: float, warmup_s: float,
             q_ref: float = 0.0, p: PlantParams = PlantParams()) -> SimTrace:
    """Run warm-up plus clip at 1 kHz. `controller.step(State, dt)` returns a Command."""
    enc_seed, reset_seed = seed_seq.spawn(2)
    enc = EncoderX14(np.random.Generator(np.random.PCG64(enc_seed)), p)
    reset_rng = np.random.Generator(np.random.PCG64(reset_seed))

    dt = 1e-3
    n_warm = int(round(warmup_s / dt))
    n = n_warm + int(round(duration_s / dt)) + 1
    brownout_step = int(reset_rng.uniform(0.25, 0.6) * n_warm)   # one brown-out during warm-up

    q, qd = 0.0, 0.0
    hist = [q] * (p.read_delay_ms + 1)
    out_q = np.empty(n)
    out_u = np.empty(n)
    out_f = np.empty(n, dtype=np.int8)
    enc.reset()                                                   # power-on reset
    error = None
    for k in range(n):
        if k == brownout_step:
            enc.reset()
        hist.append(q)
        hist.pop(0)
        q_meas, raw, status = enc.read(hist[0], dt)
        state = State(t=(k - n_warm) * dt, q_meas=q_meas, q_ref=q_ref, qd_ref=0.0,
                      enc_raw=raw, enc_status=status)
        try:
            cmd = controller.step(state, dt)
            u = float(cmd.u)
            writes = list(cmd.reg_writes or ())
        except Exception as exc:  # noqa: BLE001 - any controller failure ends the run
            error = f"{type(exc).__name__}: {exc}"
            u, writes = float("nan"), []
        if error is None and (not math.isfinite(u) or abs(u) > 1.0 + 1e-9):
            error = f"invalid command u={u!r} at t={state.t:.3f}s"
        if error is not None:
            out_q, out_u, out_f, n = out_q[:k], out_u[:k], out_f[:k], k
            break
        for addr, value in writes:
            enc.write(int(addr), int(value))
        qdd = (p.torque_max * u - p.viscous * qd) / p.inertia
        qd += qdd * dt
        q += qd * dt
        out_q[k], out_u[k], out_f[k] = q, u, enc.filt
    t = (np.arange(n) - n_warm) * dt
    return SimTrace(dt=dt, t=t, q=out_q, q_ref=np.full(n, q_ref), u=out_u, filt=out_f, error=error)
