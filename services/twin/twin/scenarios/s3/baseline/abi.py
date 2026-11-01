from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class State:
    t: float
    position_mm: float
    target_mm: float
    velocity_mm_s: float
    resonance_band: bool


@dataclass(slots=True)
class Command:
    velocity_mm_s: float
