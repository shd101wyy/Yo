# A GADT match arm is type-checked only when some caller instantiates its index

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 1.1); split out
of `issues/fixed/enum-type-constructor-arguments-are-ignored-by-type-compatibility.md` on
2026-09-24 when that issue's identity and construction halves were fixed.
**Status:** OPEN. Fix belongs to Phase 6 (the deferred-generic trial's swallow), not to
compatibility.
**Measured:** develop `251522b21` + the Phase 1.1 fix: `yo check` rc=0.

## Repro

```rust
{ println } :: import("std/fmt");
Value :: (fn(comptime(T) : Type) -> comptime(Type))(
  enum(
    IntVal(i : i32) -> recur(i32),
    BoolVal(b : bool) -> recur(bool),
    PairVal(a : i32, b : bool) -> recur(i32)
  )
);
eval_bad :: (fn(generic(T : Type), v : Value(T)) -> T)(
  match(v, .IntVal(i) => i, .BoolVal(b) => i32(7), .PairVal(a, b) => a));
main :: (fn() -> unit)({
  x := Value(i32).IntVal(i32(77));
  println(eval_bad(x));
});
export(main);
```

The `.BoolVal(b) => i32(7)` arm is wrong under refinement (`T` is `bool` there, the arm yields
`i32`). `yo check` accepts the program. Calling `eval_bad` at `Value(bool)` does reject it.

## Mechanism (MEASURED)

- A `generic(...)` fn defers its body to call time. The definition-time "deferred-generic" trial
  (`src/evaluator/calls/function_type.yo`, the `check_deferred_generic_return_type` site and the
  V6 diagnostic trial) evaluates the body once with `T` a SomeT. In that trial every GADT arm is
  reachable (`gadt_branch_reachable` treats a SomeT index as matching) and
  `_gadt_refined_expected` (`src/evaluator/exprs/match.yo`) refines the expected `T` to the arm's
  index, so the arm IS checked and the "GADT type mismatch in branch" error IS thrown, and the
  trial swallows it.
- At a specialization (`T = i32`) the `BoolVal` arm is GADT-unreachable and is skipped
  (`should_process` in `evaluate_match`), so no specialization ever checks it.

The same swallow hides a plain type error in a generic body that does not depend on `T`:
`(fn(generic(T : Type), x : T) -> i32)({ (z : bool) = i32(3); i32(1) })` passes `check` unless
it is called. That is the general Phase 6 finding; this doc tracks the GADT face of it.

## Fix direction

Phase 6 step 2/3: an error raised in the deferred-generic trial whose types are concrete (here,
`bool` against `i32` after refinement) cannot be fixed by any specialization and is re-raised.
Checking the arm at the `T = i32` specialization instead would be unsound: every other mention of
`T` in the arm body would still read `i32`.

## Test

A check-level cli-case (the error is a swallowed def-time error, which `comptime_expect_error`
observes even on the broken compiler).
