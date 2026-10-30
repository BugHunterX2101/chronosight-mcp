"""Elbow joint PD controller: retuned gains, encoder filter enabled after every reset."""
import math

from abi import REG_CONF2, STATUS_RST, Command, State

ENC_FILT = 3            # FILT[2:0] = 3, EncoderX-14 p. 31


class Controller:
    def __init__(self, params):
        self.kp = float(params["KP"])
        self.kd = float(params["KD"])
        self.angle_lpf_hz = float(params["ANGLE_LPF_HZ"])
        self.deriv_lpf_hz = float(params["DERIV_LPF_HZ"])
        self.enc_filt = int(params.get("ENC_FILT", ENC_FILT))
        self.q_f = None
        self.q_prev = None
        self.dq_f = 0.0
        self.configured = False

    def step(self, state: State, dt: float) -> Command:
        writes = []
        # Errata E-3 (p. 58): a reset clears CONF2, so rewrite FILT whenever STATUS_RST is set.
        if not self.configured or state.enc_status & STATUS_RST:
            writes.append((REG_CONF2, self.enc_filt))
            self.configured = True

        a_q = 1.0 - math.exp(-2.0 * math.pi * self.angle_lpf_hz * dt)
        a_d = 1.0 - math.exp(-2.0 * math.pi * self.deriv_lpf_hz * dt)

        q = state.q_meas
        self.q_f = q if self.q_f is None else self.q_f + a_q * (q - self.q_f)
        dq = 0.0 if self.q_prev is None else (self.q_f - self.q_prev) / dt
        self.q_prev = self.q_f
        self.dq_f += a_d * (dq - self.dq_f)

        u = self.kp * (state.q_ref - self.q_f) + self.kd * (state.qd_ref - self.dq_f)
        return Command(u=max(-1.0, min(1.0, u)), reg_writes=writes)
