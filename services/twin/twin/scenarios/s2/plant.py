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
    temp_c: np.ndarray
    fan_rpm: np.ndarray
    led_code: np.ndarray
    hotspot_area: np.ndarray
    error: str | None = None


def simulate(controller, seed_seq: np.random.SeedSequence, duration_s: float, warmup_s: float) -> SimTrace:
    rng = np.random.default_rng(seed_seq)
    dt = 1e-3
    n = int(round((duration_s + warmup_s) / dt)) + 1
    temp = 35.0
    duty = 0.92
    values = [[] for _ in range(5)]
    error = None
    for k in range(n):
        t = (k - int(round(warmup_s / dt))) * dt
        fan = max(0.0, (temp - float(controller.fan_start)) * float(controller.fan_gain) * 300.0)
        led = "3-long" if temp >= 82.0 else "steady-on"
        state = type("State", (), {"t": t, "temp_c": temp, "duty": duty, "led_code": led, "fan_rpm": fan})()
        try:
            duty = float(controller.step(state, dt).duty)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            break
        if not np.isfinite(duty) or not 0 <= duty <= 1:
            error = f"invalid duty={duty!r}"
            break
        cooling = 0.010 * fan
        temp += (duty * 8.0 - cooling - 0.018 * (temp - 25.0)) * dt
        area = max(50.0, 900.0 + (temp - 45.0) * 24.0 - fan * 0.45 + rng.normal(0, 2))
        values[0].append(temp)
        values[1].append(duty)
        values[2].append(fan)
        values[3].append(led)
        values[4].append(area)
    n = len(values[0])
    t = (np.arange(n) - int(round(warmup_s / dt))) * dt
    return SimTrace(dt, t, np.asarray(values[0]), np.zeros(n), np.asarray(values[1]),
                    np.zeros(n, dtype=np.int8), np.asarray(values[0]), np.asarray(values[2]),
                    np.asarray(values[3], dtype=object), np.asarray(values[4]), error)
