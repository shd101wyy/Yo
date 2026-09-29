# A generic `T` bound only by a closure that returns an `io.async` future is not inferred (E0613)

**Severity:** S2 — a valid program is rejected; naming the future type on the result binding is the other spelling
**Found:** 2026-09-30, writing `tests/explicit_allocators.test.yo` for `plans/EXPLICIT_ALLOCATORS.md` P3 (`arena.scoped(() => io.async(...))`: a task created inside an allocation scope).

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
infers `T`. v0.2.45 and a stage-1 built from develop both reject it.

## Expected

`T` binds to the closure's result type, the `io.async` future, exactly as it
binds to `i32` for a value-returning closure.
