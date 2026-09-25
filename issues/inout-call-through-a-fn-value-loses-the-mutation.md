# Calling an `inout`-parameter function through a fn value silently loses the mutation

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** PARTIALLY FIXED 2026-09-24. The codegen half (Phase 1.9 of
`plans/TYPE_SYSTEM_SOUNDNESS.md`) is fixed: both repros print the right value and the emitted cast
passes a pointer. OPEN for the evaluator half (Phase 3.5): `fn(inout(x) : T)` and `fn(x : T)` are
still one type — see "Remaining". Originally: **wrong code** with a green `check` and `compile`.
**Measured:** the yo 0.2.39 seed prints `v=6` and `v=5` (wrong). A develop build `d455b6a67` prints the expected
`v=7` and `v=6`, but emits the identical truncating cast shown below, so the correct output there is
undefined behaviour that happens to work, not a fix.

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
`issues/fixed/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md`), so nothing upstream
disagrees.

## Fix direction

Lower `param_is_ref` parameters to `T*` in every fn-pointer type string (value calls, struct field
types, casts). Make `fn(inout(x) : T)` and `fn(x : T)` distinct types in the evaluator. Add a
runtime test covering a local, a struct field and a closure-typed slot.

## Fix (2026-09-24, codegen)

`src/codegen/exprs/other_fn_call.yo`, the fn-pointer call path: the cast's parameter types and
the per-argument casts both go through `_fn_pointer_param_type_string`, which spells a
`param_is_ref` parameter `T*` — the callee's prototype. The call is now
`((void (*)(int32_t*))f)((int32_t*)((&(v))))`. `tests/type_soundness.test.yo` runs a fn-typed
local and a fn-typed struct field and asserts the mutations.

## Remaining (MEASURED 2026-09-24)

```rust
(g : (fn(x : i32) -> unit)) = bump;   // bump is fn(inout(x) : i32)
```

is accepted by `check`: the evaluator's Func compatibility ignores parameter modes. It happens to
run correctly here only because codegen resolves `g` to `bump` and calls it directly; through a
genuinely dynamic value it would pass an `i32` where an `int32_t*` is expected. Phase 3.5 makes
the modes part of the fn type.
