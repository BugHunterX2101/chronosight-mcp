from abi import Command


class Controller:
    def __init__(self, params):
        self.microstep = int(params["MICROSTEP"])
        self.skip_speed = float(params["RESONANCE_SKIP_MM_S"])
        self.hold_current = float(params["HOLD_CURRENT"])

    def step(self, state, dt):
        speed = 380.0
        if self.microstep >= 8:
            speed = self.skip_speed + 80.0
        return Command(velocity_mm_s=speed)
