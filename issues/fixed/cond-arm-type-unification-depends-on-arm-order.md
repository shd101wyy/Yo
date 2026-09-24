# `cond`/`match` arm type unification depends on arm order

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** FIXED 2026-09-24 (Phase 1.5 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Originally OPEN: the same expression type-checked or not depending on arm order.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  c := true;
  y := cond(c => i64(2), true => 1);   // accepted
  x := cond(c => 1, true => i64(2));   // rejected
  println(`${x} ${y}`);
});
export(main);
```

The second binding fails with
`error[E0601]: ... Previous: comptime_int, Current: i64`; the first is accepted.

## Mechanism (READ)

`src/evaluator/exprs/cond.yo` (~530-545) checks `are_types_compatible(current, previous)` and, on
failure, retries with `previous` widened to its runtime default (`comptime_int -> i32`). It never
widens the comptime arm to the *sibling's* type. `src/evaluator/exprs/match.yo` has the same shape.

## Fix direction

Compute the arm join symmetrically: if one side is `comptime_int`/`comptime_float` and the other a
concrete numeric type that can hold it, the join is the concrete type, regardless of order. Only
default to `i32`/`f64` when every arm is comptime.

## Fix

`src/evaluator/exprs/cond.yo` and `src/evaluator/exprs/match.yo`: when the running arm type does
not accept the current arm, a PREVIOUS `comptime_int`/`comptime_float` arm that widens into the
current arm's concrete type joins at that type, the mirror of the order that already worked. Only
comptime numerics get the symmetric rule; a general subtype join is not introduced. After the
loop, every `comptime_int` arm value is range-checked against the joined type
(`cond(c => 300, true => u8(1))` is E1102), because joining is where the arm is coerced.

## Verification

`cond(c => 1, true => i64(2))`, `cond(c => i64(2), true => 1)` and the `match` twin all type as
`i64` (`tests/type_soundness.test.yo`).
