import numpy as np

from twin.sim.loader import load_baseline
from twin.sim.run import simulate


def test_s2_is_deterministic_and_has_fault_signal():
    first, _ = load_baseline("s2")
    second, _ = load_baseline("s2")
    a = simulate("s2", first, 7)
    b = simulate("s2", second, 7)
    assert a.error is None
    assert np.array_equal(a.temp_c, b.temp_c)
    assert float(a.temp_c[-1]) > 82.0
    assert "3-long" in set(a.led_code.tolist())


def test_s3_is_deterministic_and_fault_loses_steps():
    controller, _ = load_baseline("s3")
    trace = simulate("s3", controller, 7)
    assert trace.error is None
    assert np.array_equal(trace.position_mm, simulate("s3", load_baseline("s3")[0], 7).position_mm)
    assert float(trace.position_mm[-1]) < 300.0
    assert float(np.std(trace.vibration_mm)) > 0.2
