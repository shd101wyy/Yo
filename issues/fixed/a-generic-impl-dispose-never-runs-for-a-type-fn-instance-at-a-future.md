# A generic `impl ... Dispose` never runs for a type-function instance at a future

**Severity:** S2 — silent wrong behavior: a guard's `Dispose` does not run, so the cleanup it exists for is skipped, with no diagnostic

**Status: FIXED (2026-10-01).** The fix is in the evaluator (below). Found 2026-10-01 while fixing
`issues/fixed/an-io-async-future-in-a-generic-struct-field-lowers-to-two-c-types.md`.
That doc's third shape, the phantom guard, failed in the C compiler
then. On the v0.2.47 seed it compiles, but the guard's dispose is never
called. **Measured** on macOS 26.6 with `--allocator system` and
`leaks --atExit`.

## Reproducer

```rust
{ println } :: import("std/fmt");
_G :: (fn(comptime(T) : Type) -> comptime(Type))(ref(struct(n : u8)));
impl(generic(T : Type), _G(T), Dispose(dispose : (fn(self : Self) -> unit)({
  println("guard released");
})));
_guarded :: (fn(generic(T : Type), f : Impl(Fn() -> T)) -> T)({
  g := _G(T)(n : u8(1));
  f()
});
main :: (fn(io : Io) -> unit)({
  task := _guarded(() => io.async((io : Io) => i32(8)));
  println(io.await(task, io));
});
export(main);
```

It prints `8` and never `guard released`. With a second call at a `ref`
struct (`_guarded(() => _P(v : i32(5)))`), that specialization's guard does
print `guard released`, so the impl works at that instance. `leaks` reports
`0 leaks`, so the guard's memory is freed, just without its `Dispose`.

## What the C shows

The future specialization's guard is
`__yo_t_…  /* _G(Impl(Future(i32, Io))) */`. Its constructor sets
`obj->header.dispose_fn = NULL`, and the C contains no `guard released` at
all. The generic `Dispose` impl is never instantiated for
`_G(Impl(Future(i32, Io)))`. The local is created, decremented at scope end
and freed with no dispose.

## Cause

`_bind_forall_from_type_args` (`src/evaluator/values/impl.yo`) recovered no binding for an
unresolved `Impl(Future(..))` type argument, which has no resolution and is not a concrete type.
So the impl match reported `all_bound = false`, and no `___dispose` was registered for
`_G(<future>)`.

## Fix

A future handle binds as itself (`_is_future_handle_slot`). It is a type in its own right:
`type_key` keys it by its own id, and it lowers to the future handle. So
`impl(generic(T), _G(T), Dispose)` matches `_G(<future>)`.

Test in `tests/async/sm_ownership.test.yo`: "a generic Dispose impl runs for a guard over a
future, as over a ref struct". It counts both guards, and it fails on a stage 1 without the fix
while the two other generic-aggregate shapes pass. Linux, stage 1 from the tree, leak verdicts on.

## Mechanism as first guessed (before the trace)

The earlier doc's partial cause applies: with `T` bound to an unresolved
future type variable, substitution cannot move `_G(T)` to a concrete
instance, and `canonicalize_instantiation_via_ctfe_memo` excludes type
arguments that carry a type variable. So the impl lookup for `Dispose` on
the guard's type does not match the `impl(generic(T), _G(T), ...)`
registration. Where the impl lookup gives up is the next thing to trace:
the evaluator's dispose-impl resolution for a struct instance whose type
argument is a `SomeT`.

## Test plan (as written before the fix)

The reproducer as a test that counts dispose calls (the
`tests/async/sm_ownership.test.yo` `g_disposed` pattern): one guard per
specialization, at a `ref` struct and at a future, so the count must be 2.
