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

## Suggested fix

Derive the comparison signedness from the measure term's declared type
(the `decreases_expr` ExprInfo type, or `_type_sort` of the measure's
task param type): unsigned sorts emit `bvuge`/`bvult`, signed sorts keep
`bvsge`/`bvslt`. The task-4 mutual-recursion fixtures
(`tests/spec/fixtures/{valid,negative}/mutual_recursion*.yo`) use `i32`
measures with an explicit `requires(n >= 0)` bound until this lands —
switch them to `u64` when fixing.
