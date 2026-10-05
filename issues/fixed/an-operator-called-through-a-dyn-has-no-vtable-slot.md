# An operator called through a `Dyn` has no vtable slot

**Severity:** S1 — a valid program (`d == p` on a `Dyn(Eq(Point))`) compiles to an abort stub: an internal compiler error at `yo compile`

**Status: FIXED (2026-10-05).** Found while writing the `Dyn(Eq(Point))` test that `plans/VALUES_BY_DEFAULT.md` decision 34 asks for. The v0.2.52 seed has it.

## Symptom

```rust
_PmPt :: struct(x : i32, y : i32);
impl(_PmPt, Eq(_PmPt)((==) : (fn(lhs : Self, rhs : _PmPt) -> bool)((lhs.x == rhs.x) && (lhs.y == rhs.y))));
main :: (fn() -> unit)({
  (d : Dyn(Eq(_PmPt))) = dyn(_PmPt(x : i32(1), y : i32(2)));
  b := (d == _PmPt(x : i32(1), y : i32(2)));
  println(b);
});
```

```
yo: error: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

`d.(==)(p)` fails the same way, and so does any user trait whose receiver is not labeled `self` (`same : (fn(lhs : Self, rhs : P) -> bool)` called as `d.same(p)`). With the receiver labeled `self`, the same program runs.

## Root cause

`dyn_member_is_method` (`src/types/utils.yo`) decided "is this trait member a method reachable through a `Dyn`" by the first parameter's LABEL alone (`self`). The operator traits label their receiver `lhs`, so no `(==)` slot was generated in the vtable (`src/codegen/types/generation.yo`, `src/codegen/functions/dyn.yo`). The evaluator still resolved and typed the call through the trait, so codegen found a typed call with no slot to dispatch to and emitted the abort stub.

## Fix

A member is a method when its first parameter is labeled `self` **or** has type `Self`. That is what makes it a receiver: the vtable wrapper takes it as `void* self_ptr` positionally and never reads the label. Regression test: `tests/parameter_modes.test.yo` "Dyn(Eq(Point)) over a by-value operator impl", which fails on the seed with the error above.
