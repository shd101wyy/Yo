# A generic `T` bound only by a closure that returns an `io.async` future is not inferred (E0613)

**Severity:** S2 — a valid program is rejected, and annotating the result binding does not help. This shape is `arena.scoped(() => io.async(...))`, a task created inside an allocation scope
**Found:** 2026-09-30, writing `tests/explicit_allocators.test.yo` for `plans/archive/EXPLICIT_ALLOCATORS.md` P3 (`arena.scoped(() => io.async(...))`: a task created inside an allocation scope).

## Reproducer

```rust
{ assert } :: import("std/assert");
call_it :: (fn(generic(T : Type), f : Impl(Fn() -> T)) -> T)(f());
test("a future returned through a generic closure-taking function", {
  task := call_it(() => io.async((io : Io) => i32(8)));
  v := io.await(task, io);
  assert((v == i32(8)), "value");
});
```

```
error[E0613]: Cannot infer the type parameter "T" of this call: it appears in the result type T, and neither an argument nor the expected type determines it.
```

The same shape with a closure returning an ordinary value (`call_it(() => i32(8))`)
infers `T`. v0.2.45, v0.2.46 and a stage-1 built from develop all reject it. Annotating
the binding, `(task : Impl(Future(i32, Io))) = call_it(...)`, is rejected the same way.

## Expected

`T` binds to the closure's result type, the `io.async` future, exactly as it
binds to `i32` for a value-returning closure.

## Cause

Two places treated the `io.async` future as "not a type yet". The future's type
is a type variable bounded by `Future`, which lowers to its state machine, so
codegen already counts it as concrete (`type_contains_some_type` exempts `Fn`-
and `Future`-bounded variables).

1. **The closure's result binder.** In `src/evaluator/values/anonymous_function.yo`,
   a closure literal checked against `Impl(Fn() -> T)` binds `T` to its body type
   and replaces the declared result with it, but only when the body type mentions
   no type variable at all. So `() => io.async(...)` kept the declared `T` as its
   result.
2. **The call's structural forall fallback.** `_funcval_bind_foralls`
   (`src/evaluator/calls/function.yo`) synthesizes each parameter against its
   argument in a scratch env and adopts a binder only if `!is_some_type` holds.
   `T := Impl(Future(i32, Io))` was dropped. The return re-evaluation then still
   produced `T`, and the E0613 check at the end of the inline call path fired.

`YO_DEBUG_RRE=1` shows the second one: `[rre] callee=_call_it ... hkt=T resolved_ret=T`.

## Fix

Both places use the codegen notion of concrete, `!type_contains_some_type_deep(ty)`.
A `Future`- or `Fn`-bounded variable binds `T`, while an unbounded variable
(a generic caller's `U`) still does not. The regression test is the
"a generic T bound by a closure that returns an io.async future" case in
`tests/async_generic_future_return.test.yo`, which fails on develop and passes with
the fix. `tests/explicit_allocators.test.yo` "A task keeps its scope across a
suspension" exercises the same shape through `with_allocator`.
