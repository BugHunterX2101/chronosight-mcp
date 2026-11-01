from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class State:
    t: float
    temp_c: float
    duty: float
    led_code: str
    fan_rpm: float


@dataclass(slots=True)
class Command:
    duty: float
