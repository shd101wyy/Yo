# Loop-variant obligations hardcode SIGNED comparisons, like `decreases` did

**Severity:** S2 — loop-variant obligations hardcode signed comparisons — a sound program with an unsigned `decreases` measure is falsely refuted

**Status:** fixed 2026-10-02 (safe-mode handover §3.7)
**Found:** 2026-09-15, reviewing PR #695

## What

PR #695 fixed the function-level `decreases` obligations: `decreases-nonneg` and
`decreases-step` now derive their comparison from the measure's own type via
`_measure_is_signed` (`bvsge`/`bvuge`, `bvslt`/`bvult`). See
`issues/fixed/verifier-decreases-nonneg-is-signed-for-unsigned-measures.md`.

The **loop-variant** obligations were not changed and still hardcode the signed
forms — measured on `fix/verifier-decreases-unsigned` after the fix:

| site | obligation | op |
| --- | --- | --- |
| `src/verifier/vc.yo:1865` | `loop-variant-continue` | `VcOp.BvSlt` |
| `src/verifier/vc.yo:2000` | `loop-variant-nonneg`   | `VcOp.BvSge` |
| `src/verifier/vc.yo:2061` | loop-variant step (havoc) | `VcOp.BvSlt` |

So a `while` carrying `decreases(M)` with an unsigned `M` (usize/u64 — the
common counter and length shapes) hits exactly the bug #695 just removed from
the function case.

## Severity: false alarm, NOT a soundness hole — and why

The same argument that made the function-level case safe applies here, and it
was checked rather than assumed. `loop-variant-nonneg` at `vc.yo:2000` is
emitted **unconditionally** whenever the loop carries a measure:

```yo
m_havoc := match(a.decreases, .Some(dm) => _expr_term(ctx, dm), .None => ...);
if(m_havoc.is_some(), {
  ...
  _emit(ctx, String.from("loop-variant-nonneg"), ..., _app2(VcOp.BvSge, m, zero));
});
```

There is no guard. An unsigned variant therefore fails the entry obligation at
`2^63` (z3 picks the high bit as "negative"), the loop is never verified, and
the signed step comparison at 1865/2061 never gets the chance to discharge a
growing measure. The conservative direction — a sound program reported refuted.

**This is the same coupling as the function case, so it carries the same trap:**
fixing `loop-variant-nonneg` alone, or making it conditional, converts a loud
false alarm into a silent soundness hole. `bvslt(2^63, 0)` is TRUE, so an
unsigned variant that GROWS across the high bit would read as shrinking and the
loop would verify. Fix all three sites in one change.

## Fix

Reuse `_measure_is_signed(ctx, dm)` — already introduced by #695 at
`vc.yo:~277` — at all three sites, exactly as the function-level emissions now do.

## Verification

- Positive: a `while` with a `usize` variant that genuinely decreases must VERIFY
  (it currently refutes).
- Negative, and this is the one that matters: a `u64` variant that INCREASES
  across `2^63` must REFUTE. Without this fixture the step direction is gated
  only by the nonneg obligation firing first, which is precisely the coupling
  that makes a partial fix dangerous.

## Outcome (2026-10-02)

All three sites now take their comparison from the measure's own type, through
two helpers shared with the function-level `decreases` obligations in
`src/verifier/vc.yo`:

- `_emit_measure_nonneg` emits `decreases-nonneg` / `loop-variant-nonneg`. It
  uses `bvsge` for a signed measure and `bvuge` for an unsigned one, and checks
  each component of a lexicographic measure separately. The loop site used to
  compare the concatenation signed.
- `_measure_lt_op` gives `bvslt` / `bvult` for `decreases-step` and for
  `loop-variant-decreases` / `loop-variant-continue`.

Measured with the v0.2.48 seed before the fix:

- `tests/spec/fixtures/valid/loop_decreases_unsigned.yo`: a usize `n - i`
  measure was REFUTED at both `loop-variant-nonneg` and `loop-variant-decreases`.
- `tests/spec/fixtures/negative/loop_measure_grows_unsigned.yo`: a u64 measure
  going 2^63 - 1 → 2^63 VERIFIED, at the body-end step and at a continue site.

That second result refines the analysis above. The old all-signed pair was
still a sound termination argument: signed order over signed-non-negative
values is well-founded. What it did not do was check the measure in the order
of the type the user wrote. Both fixtures now give the expected verdicts, and
`tests/internal/verifier_loops.test.yo` pins them (`YO_TEST_Z3=1`). The
negative test asserts which obligation refutes: the body-end step in one
function, the continue site in the other.
