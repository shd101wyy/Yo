# verifier: `decreases`-nonneg obligation is SIGNED for unsigned measures

Found 2026-09-14 during V6 task 4 (mutual-recursion decreases), routing
around it in the fixtures; the fix is small but touches the V4 walk rule
so it is filed separately.

## Symptom

A verified function with an UNSIGNED measure refutes its own
`decreases-nonneg` entry obligation:

```rust
f :: (fn(n : u64, decreases(n)) -> (r : bool))(...);
```

The obligation script renders

```smt
(assert (not (bvsge n (_ bv0 64))))
```

`bvsge` is the SIGNED comparison: z3 picks `n = 0x8000000000000000`
(high bit set, "negative" as signed), the proof fails, and a perfectly
sound unsigned measure is reported refuted.

## Root cause

`src/verifier/vc.yo`, the `decreases-nonneg` emission (V4), hardcodes
the signed comparison `VcOp.BvSge` for the entry-ground obligation and
`VcOp.BvSlt` for the `decreases-step` obligation, regardless of the
measure's type. The signedness resolution that every other comparison
goes through (`_binop_of_ctx`, signedness from the first argument's
type) is not applied here.

Unsigned measures (`usize` lengths, `u64` counters) are exactly the
common loop/recursion measures, so this bites any unsigned-measure
fixture. The V4 fixtures did not catch it because
`tests/spec/fixtures/valid/recursion_decreases.yo` uses `i32`.

## Why this is SAFE today, and the trap in fixing it (added 2026-09-15, review of #691)

The symptom above is a FALSE ALARM — a sound measure is reported refuted, which
is the conservative direction for a verifier. But the same defect has a second
half that is NOT conservative, and the doc should say so before anyone touches
it:

**`decreases-step` is signed too** (`vc.yo:3761`, `VcOp.BvSlt`), and signed is
the UNSOUND direction there. For an unsigned measure going `0 -> 2^63` — an
INCREASE — `bvslt` reads `2^63` as most-negative, so `bvslt(2^63, 0)` is TRUE
and the obligation is discharged. The verifier would conclude a growing measure
shrank and accept non-terminating recursion.

That is not reachable today only because **`decreases-nonneg` is emitted
UNCONDITIONALLY** for every function carrying `decreases(M)` (`vc.yo:4021`, the
`match(ctx.decreases, .Some(dm) => …)` with no guard). Any unsigned measure
fails that entry obligation at `2^63`, so the function is never verified and the
bad step comparison never grants a false pass. The false alarm is what keeps the
unsoundness unreachable.

**So: do NOT fix `decreases-nonneg` alone, and do not make it conditional.**
Fixing the entry obligation while leaving `decreases-step` signed converts a
loud false alarm into a silent soundness hole — unsigned measures would start
passing entry and then be checked for decrease with the wrong comparison. Fix
both in the same change, and add an unsigned NEGATIVE fixture (a `u64` measure
that increases across `2^63` and must REFUTE) so the step direction is gated by
a test rather than by the nonneg obligation happening to fire first.

The same hardcoded signedness is in the loop-variant obligations
(`vc.yo:1853` `BvSlt`, `1988` `BvSge`, `2049` `BvSlt`) — check whether the same
argument holds there, or whether a loop variant can reach the step without a
nonneg gate.

## Suggested fix

Derive the comparison signedness from the measure term's declared type
(the `decreases_expr` ExprInfo type, or `_type_sort` of the measure's
task param type): unsigned sorts emit `bvuge`/`bvult`, signed sorts keep
`bvsge`/`bvslt`. The task-4 mutual-recursion fixtures
(`tests/spec/fixtures/{valid,negative}/mutual_recursion*.yo`) use `i32`
measures with an explicit `requires(n >= 0)` bound until this lands —
switch them to `u64` when fixing.
