# Calling an `inout`-parameter function through a fn value silently loses the mutation

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 3).
**Status:** FIXED. The codegen half (Phase 1.9) landed 2026-09-24; the evaluator half (Phase 3.5 of
`plans/TYPE_SYSTEM_SOUNDNESS.md`) landed 2026-09-25: `fn(inout(x) : T)` and `fn(x : T)` are two
types. Originally: **wrong code** with a green `check` and `compile`.
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

## Fix (2026-09-25, evaluator: Phase 3.5)

`src/types/compatibility.yo`, the `Func` arm of `_compat_impl`, in both relations: each parameter's
`inout` and `own` flags, `-> inout(T)`, and the implicit (`using`) parameters (count and types; labels
too under identity) are part of the fn type. `(g : (fn(x : i32) -> unit)) = bump` is now
`Incompatible types`, and the CTFE memo no longer hands `Wrap(fn(inout(x) : i32) -> unit)` the
by-value instance (memo Repro 3 of
`issues/fixed/ctfe-memo-merges-an-anonymous-struct-with-a-named-struct.md`, the SIGSEGV).

`type_to_string` (`src/types/string.yo`) now prints the modes (`fn(inout(x) : i32) -> unit`). That
rendering is also the codegen key of a fn type, so an `inout` and a by-value fn type no longer
share one C name either.

One deliberate exception, in `src/evaluator/values/impl.yo` (`_with_receiver_mode_of`): an impl
member may spell the RECEIVER in any form `docs/en-US/DYN_DESIGN.md` lists (the prelude's
`impl(unit, Clone(clone : (fn(self : Self) -> Self)(())))` against `clone : fn(inout(self) : Self)`).
The call site adapts to the impl's own signature and a Dyn vtable slot goes through a wrapper, so
only the receiver's mode is taken from the trait before the conformance check. Every other
parameter's mode must match.

`tests/type_soundness.test.yo`: "parameter modes are part of a fn type" (both assignments rejected,
`Type.eq` and `Type.is_compatible_with` answers), "the memo keeps a by-value and an inout
instantiation apart", and a canary for each mode flowing into a slot of the same mode.
