# `yo verify` prints z3's own error lines under an `unproven` obligation

**Severity:** S3: report noise. The verdict is correct, but z3 messages that look like failures leak into the human-readable output.

**Status: OPEN.** Found 2026-10-03 while writing FORMAL_VERIFICATION §Verified `for` loops (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49 with the pinned z3.

## Symptom

When the solver answers `unknown`, the `UNPROVEN unknown` line is followed by z3's replies to the follow-up `(get-unsat-core)` and `(get-model)` queries:

```
    fn@….yo:…/loop-invariant-iterate: UNPROVEN unknown
(error "line 19 column 15: unsat core is not available")
(error "line 20 column 10: model is not available")
```

Repro: the §Verified `for` loops copy example with std's `out.push(x)` in place of the `push_at_end` wrapper.

## Expected

The runner already tolerates these replies after `unknown`, so it should also keep them out of the report.
