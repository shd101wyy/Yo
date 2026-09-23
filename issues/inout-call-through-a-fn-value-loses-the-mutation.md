# Calling an `inout`-parameter function through a fn value silently loses the mutation

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** OPEN. **Wrong code** with a green `check` and `compile`.
**Measured:** yo 0.2.39 seed (re-run by the auditor: prints `v=6` and `v=5`).

## Repro 1: through a fn-typed local

```rust
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
bump :: (fn(inout(x) : i32) -> unit)({ x = (x + i32(1)); () });
main :: (fn() -> unit)({
  (f : (fn(inout(x) : i32) -> unit)) = bump;
  (v : i32) = i32(5);
  f(v);
  bump(v);
  unsafe(printf("v=%d\n", v));   // prints v=6, expected v=7
  ()
});
export(main);
```

## Repro 2: through a struct field

```rust
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
Wrap :: (fn(comptime(T) : Type) -> comptime(Type))(struct(inner : T));
bump :: (fn(inout(x) : i32) -> unit)({ x = (x + i32(1)); () });
main :: (fn() -> unit)({
  (w1 : Wrap((fn(inout(x) : i32) -> unit))) = Wrap((fn(inout(x) : i32) -> unit))(inner : bump);
  (v : i32) = i32(5);
  w1.inner(v);
  unsafe(printf("v=%d\n", v));   // prints v=5, expected v=6
  ()
});
export(main);
```

## Mechanism (MEASURED from the emitted C)

The fn-pointer call is emitted as `((void (*)(int32_t))f)((int32_t)((&(v))))`. The cast type
ignores `FuncMeta.param_is_ref`, so the address of `v` is truncated to `int32_t` and passed by
value; `bump` then writes through a garbage pointer on a 64-bit target (it happens not to crash
here). The evaluator also treats `fn(inout(x) : i32)` and `fn(x : i32)` as the same type (see
`issues/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md`), so nothing upstream
disagrees.

## Fix direction

Lower `param_is_ref` parameters to `T*` in every fn-pointer type string (value calls, struct field
types, casts). Make `fn(inout(x) : T)` and `fn(x : T)` distinct types in the evaluator. Add a
runtime test covering a local, a struct field and a closure-typed slot.
