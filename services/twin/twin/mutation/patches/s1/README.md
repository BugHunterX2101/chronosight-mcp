# S1 mutation patches (DESIGN §14.4)

Each directory is a complete patch workspace (`controller.py`, `params.py`), run against
seeds 101–110 with the pre clip being the baseline on the same seed.

| Case | Change | Expected |
| :--- | :--- | :--- |
| v1 | KP 1.5, KD 0.11, FILT=3 rewritten whenever `STATUS_RST` is set | PASS |
| v2 | Placebo: comment-only edit, AST-identical to the baseline | FAIL (and caught by the AST identity check) |
| v3 | Half-fix: KD 0.0035 → 0.0043 only, amplitude falls ~40% | FAIL on `REL_REDUCTION_INSUFFICIENT` |
| v4 | Gains only: KP 12.6 (ωn ≈ 8 Hz), KD 0.032, encoder filter left off. Kills 4 Hz; the unfiltered encoder noise now drives an ~8.2 Hz ring | FAIL on `NEW_RESONANCE` |
| v5 | Raises `ZeroDivisionError` after t = 1 s | `PATCH_RUNTIME_ERROR` |
