from abi import Command


class Controller:
    def __init__(self, params):
        self.derate_temp = float(params["DERATE_TEMP_C"])
        self.fan_start = float(params["FAN_START_C"])
        self.fan_gain = float(params["FAN_GAIN"])

    def step(self, state, dt):
        duty = 0.92
        if state.temp_c > self.derate_temp:
            duty *= max(0.25, 1.0 - 0.04 * (state.temp_c - self.derate_temp))
        return Command(duty=max(0.0, min(1.0, duty)))
