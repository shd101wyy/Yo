# A comptime type argument holding a resolved `Impl` never specializes

**Severity:** S1 — internal compiler error on valid input: a call whose `comptime(T) : Type` argument is or contains `IoFuture` (std/async/waker's `Park`, any struct with an `IoFuture` field) is dropped from the generated C. In `main` it is an ICE; anywhere else the caller becomes an abort stub (a build error at `-O0`, an rc=134 abort at `-O2`).
**Found:** 2026-10-01, landing P3c of `plans/archive/EXPLICIT_ALLOCATORS.md`. A scoped `ArrayList(Park).new()` routes through `with_capacity_in` and `size_would_overflow(T, …)`, so `tests/async/waker.test.yo` stopped compiling. The bug is on develop (`439e0273e`) and in v0.2.48. P3c only exposed it.

## Reproducer

```rust
{ println } :: import("std/fmt");
{ IoFuture } :: import("std/sys/future");
f :: (fn(comptime(T) : Type, n : usize) -> usize)(n);
main :: (fn() -> unit)({
  (m : usize) = usize(4);
  println(`${f(IoFuture, m)}`);
});
export(main);
```

```
yo: error: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression
```

The body ignores `T`, and the same call with `u8` works. `size_would_overflow(Park, n)` and `ArrayList(Park).with_capacity_in(a, n)` fail the same way.

## Cause

`IoFuture :: Impl(Concrete(__yo_io_future_t), Future(i32))` is a `SomeT` whose `resolution` is the concrete `__yo_io_future_t`. The inline call arm (`src/evaluator/calls/function.yo`, the explicit-comptime-param trigger) mints a specialization only when every comptime argument is known "with no unresolved SomeT". It tested that with `get_all_some_types(tv).len() > 0`, which also counts resolved `SomeT`s. So the call kept the unspecialized original `fn(T : Type, n : usize)`, which codegen correctly skips as hard-generic (`should_skip_function_codegen`), and the call site became a `// Failed to transpile` marker.

## Fix

The trigger treats a type argument as unknown only when it has `SomeT`s that do not all resolve to a concrete type (`type_somes_all_resolve_concrete`, the same test the return-type acceptance rules use). A validation-pass placeholder `SomeT` still blocks the mint. The regression test is "A comptime type argument holding a resolved Impl specializes" in `tests/comptime_type_arg_binding.test.yo`. It fails on v0.2.48 and passes with the fix.
