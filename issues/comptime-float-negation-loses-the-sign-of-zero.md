# Comptime float negation loses the sign of zero: `-0.0` folds to `+0.0`

**Status:** OPEN
**Found:** 2026-09-08, writing `tests/math.test.yo` for the new `std/math`.

## Symptom

```rust
{ println } :: import("std/fmt");
import("std/math");
main :: (fn() -> unit)({
  (z : f64) = runtime(f64(0.0));
  println(`runtime  -(z)   sign_neg=${(-(z)).is_sign_negative()}`);   // true   (correct)
  println(`comptime -(0.0) sign_neg=${f64(-0.0).is_sign_negative()}`); // false  (WRONG)
});
export(main);
```

The runtime path is right and the comptime path is wrong, which is the tell:
it is the folder, not codegen.

## Root cause

`src/evaluator/builtins/comptime_numeric_fns.yo`, the `op_s == "neg"` branch:

```rust
.FloatLit(raw) => match(
  parse_raw_float(raw),
  .Some(v) => make_float_val(f64(0.0) - v, numeric_type),
  .None => create_unknown_val(numeric_type)
),
```

Negation is implemented as `0.0 - v`. For every value except zero that is the
same number, but IEEE-754 says `(+0.0) - (+0.0)` is `+0.0` under
round-to-nearest — subtraction cannot produce a negative zero from two
positives, while `-(+0.0)` is `-0.0` by definition (IEEE 754 §5.5.1: negation
is a sign-bit flip, not a subtraction). So the one value whose sign the
operation exists to change is the one it silently drops.

## Why it matters beyond a curiosity

`-0.0` and `+0.0` compare EQUAL, so nothing downstream reports the loss — it
only becomes visible through `is_sign_negative`, `copysign`, `signum`, or
division (`1.0 / -0.0` is `-inf`, `1.0 / 0.0` is `+inf`). A user writing
`f64(-0.0)` gets a value that is quietly not what they wrote, and the
divergence between the comptime and runtime spellings of the same expression
is itself a soundness wart: constant folding must not change a program's
meaning.

## Fix

Negate rather than subtract:

```rust
.Some(v) => make_float_val(-(v), numeric_type),
```

`v` is a runtime `f64` inside the compiler, so this is the (correct) runtime
negation — and it stays correct when compiled by a seed that still carries the
bug, since the seed's folder only mishandles a comptime ZERO literal.

The INTEGER branch beside it (`i64(0) - n`) is left alone: two's-complement
negation genuinely is `0 - n`, and its one edge case (`-i64.MIN` overflowing)
is a separate question from this one.

## Test

`tests/math.test.yo`'s "f64 sign handling" currently builds `-0.0` through
`copysign` with a comment pointing here. Once this is fixed, that test should
assert the literal `f64(-0.0).is_sign_negative()` directly, which is what a
user would write.
