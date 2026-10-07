# Forwarding a move-only `sink` closure parameter to another `sink` parameter is rejected

**Severity:** S2 — a valid program is rejected: a function cannot pass on a move-only closure it received by value, and the E0901 tells it to do what it already does ("Take the parameter `sink(...)`").

> Found 2026-10-07 while writing the `FnOnce(...)` tests for decision 37 (`plans/VALUES_BY_DEFAULT.md`). **FIXED same day.**

## Symptom

```rust
Tok :: struct(n : i32);
impl(Tok, MoveOnly());
keep :: (fn(sink(f) : Impl(Fn() -> i32)) -> i32)(f());
relay :: (fn(sink(f) : Impl(Fn() -> i32)) -> i32)(keep(f));
main :: (fn() -> unit)({
  t := Tok(n : i32(5));
  _r := relay({ t }() => t.n);
});
export(main);
```

```
error[E0901]: use of moved value: cannot copy `f`, whose type `Impl(Fn() -> i32)` is move-only, and it cannot be moved either: it is borrowed (a by-value parameter or a `match`/`for` binding), and a borrow cannot give the value away. Take the parameter `sink(...)` to own it.
4 | relay :: (fn(sink(f) : Impl(Fn() -> i32)) -> i32)(keep(f));
```

## Root cause

A closure parameter is re-bound in a specialized body as a NON-owning shadow
(`create_specialized_function_inline`, `src/evaluator/calls/helper.yo`). The
re-bind is deliberately non-owning, because an owning re-bind was measured as a
double release. The caller's `sink` transfer hands the closure to an owning
binding in an outer frame of the same env.
`move_captured_explicit_copy_variable` already finds that owner when a capture
moves the parameter (`_owning_param_binding_for_capture_move`, the
`Thread.spawn` relay fix). `transfer_explicit_copy_value`, the path for every
other move (a `sink` argument, a store, a binding), did not, so the shadow
looked like a borrowed parameter.

## Fix

`transfer_explicit_copy_value` moves through the shadow
(`_move_through_sink_shadow`, `src/evaluator/utils.yo`). It consumes the
owning outer binding, so that binding's scope-end drop is skipped, and it
marks the shadow. Both moves are logged, so a `cond`/`match` join restores them
for a sibling arm.

## Verification

`tests/fn_once.test.yo`'s sink test forwards a `sink(f) : Impl(FnOnce(...))`
parameter in one `cond` arm and calls it in the other, checking that every
capture is disposed exactly once. It is rejected before the fix and passes
after.
