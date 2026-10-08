# `dyn(...)` of a closure that captures a move-only value is a bogus E0901

**Severity:** S2 — a valid program is rejected: a `Dyn(Fn(...))` built from a closure that captures a move-only value fails with "use of moved value", pointing at the closure's own body.

> Found 2026-10-07 while writing the `Dyn(FnOnce(...))` tests for decision 37 (`plans/VALUES_BY_DEFAULT.md`). **FIXED same day.**

## Symptom

```rust
Tok :: struct(n : i32);
impl(Tok, MoveOnly());
main :: (fn() -> unit)({
  t := Tok(n : i32(9));
  (d : Dyn(Fn() -> i32)) = dyn(() => t.n);
  _r := d();
});
export(main);
```

```
error[E0901]: use of moved value: `t`
  --> tmp/fo9.yo:6:38
6 |   (d : Dyn(Fn() -> i32)) = dyn(() => t.n);
  |                                      ^
note: value moved here
  --> tmp/fo9.yo:6:35
6 |   (d : Dyn(Fn() -> i32)) = dyn(() => t.n);
  |                                   ^^
```

The capture-list form (`dyn({ t }() => t.n)`) fails the same way. Binding the
closure to an `Impl(Fn() -> i32)` local first is accepted, so only `dyn(...)` is
affected.

## Root cause

`evaluate_dyn_value` (`src/evaluator/values/dyn.yo`) evaluates its argument,
then auto-boxes it by building `box(<argument>)` and evaluating that call.
That evaluates the argument node a second time, as `box`'s argument. The
first evaluation moved `t` into the closure's capture struct at the literal's
`=>` token (`move_captured_explicit_copy_variable`). The second evaluation ran
the body again, and the body's read of `t` met a variable already moved at
another site. The capture-list form fails at its entry `{ t }` instead, whose
re-evaluated move meets the first one.

## Fix

The argument node is marked pre-evaluated (`mark_node_preevaluated`) around the
`box(...)` evaluation on both paths of `evaluate_dyn_value`, so it is
evaluated once. `_expr.yo`'s pre-evaluated short-circuit returns its existing
ExprInfo. The receiver re-wrap in `calls/function.yo` uses the same mechanism.

## Verification

`tests/fn_once.test.yo` builds a `Dyn(Fn(...))` and a `Dyn(FnOnce(...))` from
closures that capture a move-only value, and checks that each is disposed once.
Both are rejected before the fix and pass after it.
