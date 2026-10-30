# Decisions

Deviations from, and refinements of, DESIGN.md made while building. Each entry says what
DESIGN specifies, what the code does instead, and the evidence. Code comments cite these IDs.

| ID | Area | DESIGN says | Code does | Why |
| :-- | :--- | :--- | :--- | :--- |
| D-1 | S1 hard bounds | No number in the specs; our first `scenario.yaml` had `KP` [0.5, 6.0] | `KP` [0.5, 15.0]; `KD` [0.0, 0.6] unchanged | The §14.4 V4 case needs ωn ≈ 8 Hz, which takes `KP` ≈ 12.6. With the old bound V4 failed the bounds check before it was ever filmed, so the suite never exercised `NEW_RESONANCE`. Model-proposed bounds still only narrow these (§16). |
| D-2 | §13.2 step 4 | With a commanded track: d = c̃ − commanded | Also subtract mean(d) | Any constant offset between the measured and commanded centroid (steady-state error, mask centroid vs. modelled point) is not vibration. Left in, it inflates A_px and skews the principal axis. |
| D-3 | §13.2 step 8 | S_N0 = "the same spectrum for marker B" | Marker B's residual is projected onto the fault's principal axis u before the spectrum | S(f) is the spectrum of x = d·u; the floor must be on the same axis to be comparable. |
| D-4 | Result summary | `coverage` per summary (role unspecified) | `pre.coverage` / `post.coverage` = minimum over fault, refA, refB | Matches criterion 1, which needs all three roles ≥ 0.90. |
| D-5 | §14.4 V4 | "Over-damped fix that adds an 8 Hz resonance" | Gains only: `KP` 12.6, `KD` 0.032, encoder filter left off (`FILT=0`) | A truly over-damped loop has no resonance to add. Raising ωn to ~8 Hz with the 12-LSB encoder noise unfiltered produces a real, noise-driven 8.1–8.4 Hz ring (1.2–5.1 px on calibration seeds), which is the failure V4 is meant to model. |
| D-6 | §13.2 step 8 | Detrend b̃ with the moving average | Detrend B exactly like the fault: mean only when a commanded track exists, moving mean otherwise | With a commanded track the fault only loses its mean. A moving mean on B is a high-pass that shapes S_N0 below ~1 Hz, so the floor there sat far below the fault's actual noise and low-frequency noise bumps read as resonances. |
| D-7 | §14.2 criterion 2 | A_post ≤ (1 − r)·A_pre | Same rule on noise-corrected amplitudes, A_sig = sqrt(max(A² − N0², 0)) | Measured A² ≈ A_true² + N0². At 0.3 px jitter a perfect fix bottoms out at the noise floor, so raw REL failed the known-good V1 (seed 106). Criterion 3 (ceiling) stays on raw A_mm, so the correction cannot loosen the absolute limit. |
| D-8 | §14.1 oscillation precheck, §14.2 criterion 5 | Compare S with S_N0 bin by bin (+6 dB precheck, +3 dB floor, ≤ 6 dB rise) | Floor = local RMS of S_N0 over ±0.5 Hz (`smoothed_floor`), the larger of pre and post. Threshold = floor + max(DESIGN margin, `NOISE_FA_DB` = 14 dB). Rise is measured from max(S_pre, floor). | One noise realisation is Rayleigh-distributed per bin, so a bin-for-bin noise-vs-noise comparison is a coin toss. 14 dB is above the p99 (13.4–13.7 dB) of the largest local peak a pure-noise 5 s Lomb–Scargle spectrum produces over its smoothed floor. |

