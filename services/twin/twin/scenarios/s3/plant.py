from __future__ import annotations

from dataclasses import dataclass
import numpy as np


@dataclass
class SimTrace:
    dt: float
    t: np.ndarray
    q: np.ndarray
    q_ref: np.ndarray
    u: np.ndarray
    filt: np.ndarray
    position_mm: np.ndarray
    vibration_mm: np.ndarray
    error: str | None = None


def simulate(controller, seed_seq: np.random.SeedSequence, duration_s: float, warmup_s: float) -> SimTrace:
    rng = np.random.default_rng(seed_seq)
    dt = 1e-3
    n = int(round((duration_s + warmup_s) / dt)) + 1
    pos = 0.0
    lost_steps = 0.0
    target = 300.0
    out_pos, out_vib, out_u = [], [], []
    error = None
    for k in range(n):
        t = (k - int(round(warmup_s / dt))) * dt
        speed = 0.0 if pos >= target else 380.0
        resonance = 250.0 <= abs(speed) <= 500.0
        state = type("State", (), {"t": t, "position_mm": pos, "target_mm": target,
                                   "velocity_mm_s": speed, "resonance_band": resonance})()
        try:
            cmd = controller.step(state, dt)
            commanded = float(cmd.velocity_mm_s)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            break
        if not np.isfinite(commanded) or abs(commanded) > 1000:
            error = f"invalid velocity={commanded!r}"
            break
        lost = 0.004 if resonance else 0.0
        effective = commanded if k * dt < target / 380.0 else 0.0
        lost_steps += abs(effective) * dt * lost
        pos += effective * dt * (1.0 - lost)
        if pos > target:
            pos = target
        vibration = (0.9 if resonance else 0.05) * np.sin(2 * np.pi * 48.0 * t) + rng.normal(0, 0.01)
        out_pos.append(pos)
        out_vib.append(vibration)
        out_u.append(commanded)
    n = len(out_pos)
    t = (np.arange(n) - int(round(warmup_s / dt))) * dt
    q = np.asarray(out_pos)
    return SimTrace(dt, t, q, np.full(n, target), np.asarray(out_u), np.zeros(n, dtype=np.int8),
                    q, np.asarray(out_vib), error)
