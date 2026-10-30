"""Elbow joint PD controller, as shipped (faulted baseline)."""
import math

from abi import Command, State


class Controller:
    def __init__(self, params):
        self.kp = float(params["KP"])
        self.kd = float(params["KD"])
        self.angle_lpf_hz = float(params["ANGLE_LPF_HZ"])
        self.deriv_lpf_hz = float(params["DERIV_LPF_HZ"])
        self.q_f = None
        self.q_prev = None
        self.dq_f = 0.0

    def step(self, state: State, dt: float) -> Command:
        a_q = 1.0 - math.exp(-2.0 * math.pi * self.angle_lpf_hz * dt)
        a_d = 1.0 - math.exp(-2.0 * math.pi * self.deriv_lpf_hz * dt)

        q = state.q_meas
        self.q_f = q if self.q_f is None else self.q_f + a_q * (q - self.q_f)
        dq = 0.0 if self.q_prev is None else (self.q_f - self.q_prev) / dt
        self.q_prev = self.q_f
        self.dq_f += a_d * (dq - self.dq_f)

        u = self.kp * (state.q_ref - self.q_f) + self.kd * (state.qd_ref - self.dq_f)
        return Command(u=max(-1.0, min(1.0, u)))
