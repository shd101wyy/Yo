# A tail-return temporary takes another specialization's return type

**Severity:** S2 — a valid program fails in the C compiler. Nothing in `yo check` flags it.
**Found:** 2026-09-30, compiling `tests/explicit_allocators.test.yo` for `plans/archive/EXPLICIT_ALLOCATORS.md` P3. `with_allocator` is specialized once at a `ref` struct and once at an `io.async` future.

## Reproducer

```rust
_Tmp :: ref(struct(n : i32));
_P :: ref(struct(x : i32));
_call_it :: (fn(generic(T : Type), f : Impl(Fn() -> T)) -> T)({
  t := _Tmp(n : i32(1));
  f()
});
main :: (fn(io : Io) -> unit)({
  p := _call_it(() => _P(x : i32(3)));
  task := _call_it(() => io.async((io : Io) => i32(8)));
  println(p.x + io.await(task, io));
});
```

```
error: incompatible pointer types initializing '__yo_t_…* ' (the _P struct) with an expression of type '…_sync_fut_t *'
error: incompatible pointer types returning '__yo_t_…*' from a function with result type '…_sync_fut_t *'
```

## Cause

A body with a droppable local materializes its tail into `__yo_scope_ret` before
the scope-end drops (the B1 order in `generate_function_body`,
`src/codegen/functions/generation.yo`). The temporary's C type came from
`get_type_string` of the declared result `T`. That type variable resolves
through the shared resolved-concrete registry, which holds whichever
specialization wrote it last, here `_P`. The signature itself is right. It uses
`_return_type_override`, and return statements read it through
`context.override_return_type_str`. The B1 path was the one place that ignored it.

## Fix

The B1 temporary uses `context.override_return_type_str` when it is set, the same
choice `src/codegen/exprs/return.yo` already makes. The regression test is "a tail
temporary keeps each specialization's own return type" in
`tests/async_generic_future_return.test.yo`. The reproducer failed on a stage-1
without this change and passes with it.
