# A binary operator called through a `Dyn` is an internal compiler error

**Severity:** S3 — a call the language does not support (`d == p` on a `Dyn(Eq(Point))`) is reported as an internal compiler error instead of a diagnostic

Found 2026-10-05 while writing the `Dyn` test for `plans/VALUES_BY_DEFAULT.md` decision 34. The v0.2.52 seed has it.

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

`d.(==)(p)` fails the same way, and so does a user trait whose receiver is not labeled `self` (`same : (fn(lhs : Self, rhs : P) -> bool)` called as `d.same(p)`). Moved into a helper function, the body becomes an abort stub (`[ftt-stub] kind=value`) with no swallowed error under `YO_DEBUG_SWALLOW=1`.

## Root cause (partial)

A `Dyn` vtable slot exists only for a trait member whose first parameter is labeled `self` (`dyn_member_is_method`, `src/types/utils.yo`). The binary operator traits label their receiver `lhs`, so `Dyn(Eq(Point))` has no `(==)` slot. The evaluator nevertheless types the call: `_reject_dyn_unsafe_method_call` (`src/evaluator/calls/function.yo`) checks only members `dyn_member_is_method` accepts, so it never rejects a non-method member, and codegen then has nothing to dispatch to.

Measured: also accepting a first parameter typed `Self` gives `Dyn(Eq(Point))` its `(==)` and `(!=)` slots, but the call still becomes a stub, because the operator form `d == p` does not reach the method-form vtable lowering (`src/codegen/exprs/other_fn_call.yo`, `(recv).vtable->method(...)`).

## Fix direction

Either reject the call in the evaluator with the E0614-style message ("cannot be called through a Dyn receiver: its receiver `lhs` is not `self`"), or give the binary operators slots and route the operator form through the vtable lowering. `plans/VALUES_BY_DEFAULT.md` decision 34 records today's rule (no binary operator has a slot) and leaves the choice open.
