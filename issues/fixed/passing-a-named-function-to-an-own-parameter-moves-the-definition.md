# Passing a named function to an `own` parameter marks the DEFINITION moved, so every later use is "use of moved value"

**Found:** 2026-09-25, writing the rule-D9 canary in `tests/parallelism_soundness.test.yo`.
**Status:** FIXED 2026-09-25. **Class:** valid code rejected. Reproduces with the v0.2.42 seed.

## Repro

`issues/repros/passing-a-named-function-to-an-own-parameter-moves-the-definition.yo`:

```rust
_tick :: (fn() -> unit)({ println("tick"); });
_take_own :: (fn(own(cb) : Impl(Fn() -> unit)) -> unit)({ cb(); });
main :: (fn() -> unit)({
  _take_own(_tick);   // an `own` parameter consumes its argument
  f := _tick;         // error[E0901]: use of moved value: `_tick`
  f();
});
```

The same happens with `Thread(unit).spawn(worker)`, whose callback parameter is `own`.

## Mechanism

`set_expr_as_consumed` (`src/evaluator/utils.yo`) marks the variable behind an argument
expression as consumed when the argument is moved into an `own` parameter. It exempted type
values, which are reusable, but not functions. So the module-level `_work :: (fn ...)(...)`
definition itself got `consumed_at_token`, and the next use of the name failed the
moved-value check. A second call argument happened to slip past; a `:=` binding did not.

## Fix

A compile-time-only binding whose value is a function is a code pointer, re-materialized at
every use. Like a type value, it is never consumed. A local closure VALUE is not
compile-time-only and still moves, since its captured state moves with it.

Test: "a named function passed to an own parameter stays usable" in
`tests/parallelism_soundness.test.yo`, which fails on the v0.2.42 seed with the error above.
