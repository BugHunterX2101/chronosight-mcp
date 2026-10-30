"""Controller ABI for scenario S1 (DESIGN §20.2).

This file is copied read-only into every patch workspace, so a controller can
`from abi import State, Command` without importing anything from the twin.
"""
from dataclasses import dataclass, field

# EncoderX-14 register map (reference manual p. 31)
REG_CONF2 = 0x08          # FILT[2:0] lives in bits 2..0
STATUS_RST = 0x01         # enc_status bit 0: a reset happened since the last read (p. 58, errata E-3)


@dataclass(frozen=True, slots=True)
class State:
    t: float              # s
    q_meas: float         # rad, after the encoder model
    q_ref: float          # rad
    qd_ref: float         # rad/s
    enc_raw: int          # 14-bit code
    enc_status: int       # bit flags, see STATUS_RST


@dataclass(slots=True)
class Command:
    u: float                                          # PWM duty, -1..1
    reg_writes: list = field(default_factory=list)    # [(addr, value), ...]
