from twin.vut.typed import evaluate_typed


def test_s2_typed_assertions_require_repaired_thermal_state():
    pre = {"scenarioMetrics": {"ledCode": "3-long", "hotspotArea": 2000, "fanRpm": 0}}
    post = {"scenarioMetrics": {"ledCode": "steady-on", "hotspotArea": 900, "fanRpm": 120}}
    result = evaluate_typed("s2", pre, post, "patch")
    assert result.verdict == "PASS"
    assert {a.type for a in result.assertions} == {"blink_code", "area_change", "rotation_present"}


def test_s3_typed_assertions_reject_lost_steps():
    pre = {"scenarioMetrics": {"positionErrorMm": 1.2, "vibrationRms": 0.6}}
    post = {"scenarioMetrics": {"positionErrorMm": 1.2, "vibrationRms": 0.5}}
    result = evaluate_typed("s3", pre, post, "placebo")
    assert result.verdict == "FAIL"
    assert "POSITION_ERROR_HIGH" in result.assertions[0].reasons
