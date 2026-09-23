# `cond`/`match` arm type unification depends on arm order

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1).
**Status:** OPEN. Completeness bug: the same expression type-checks or not depending on arm order.
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
