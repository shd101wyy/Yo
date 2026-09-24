# A call whose generic result cannot be inferred passes `check` and ICEs in `compile`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** FIXED 2026-09-24 (Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Was: green `yo check`, internal compiler error in `yo compile`.
**Measured:** yo 0.2.39 seed; re-verified with the same result on a develop build `d455b6a67`.

## Repro

```rust
{ println } :: import("std/fmt");
mk :: (fn(generic(T : Type)) -> Option(T))(.None);
main :: (fn() -> unit)({
  x := mk(); println(1);
});
export(main);
```

`yo check` rc=0. `yo compile` reports an internal compiler error; nothing tells the user that `T`
could not be inferred.

## Fix direction

At the end of forall binding for a call, if a binder that appears in the result type is still an
unresolved SomeT and no expected type is available, raise a coded error:
`cannot infer T for mk(); annotate the binding, e.g. (x : Option(i32)) = mk()`.
Related: `issues/generic-fn-forall-unresolved-when-argument-is-a-method-call.md` (a different path
that also leaves a binder unresolved).

## Fix (2026-09-24)

Two halves, on both call paths.

1. **The expected type binds a result-only binder.** Measured first: even
   `(x : Option(i32)) = mk()` failed — Step 10 of `try_to_call` synthesized the result against the
   expected type AFTER Step 8 had extracted the specialization's forall values, and the inline
   FuncVal path used the expected type only for PARAMETER types. Step 10b now refreshes every
   still-abstract forall value from the env, and `resolve_param_types_from_expected` also returns
   the binders the expected type fixes, which the FuncVal arm binds when no argument does.
2. **Nothing binds it: E0613**, a new code (`yo explain E0613`):

   ```
   error[E0613]: Cannot infer the type parameter "T" of this call: it appears in the result type Option(T), and neither an argument nor the expected type determines it. Annotate the binding the result lands in, or pass the type with generic(...).
   ```

   Judged on the call's FINAL result type: a callee-own binder still unresolved there (empty cell,
   nothing registered) AND still unbound in the env. Both are consulted because a binder can be
   resolved through a cell chain alone (`ch.filter(x => …)`'s per-call closure `F`). A control
   function's `ResumeType` and externs are exempt.

## Verification

`tests/type_soundness.test.yo`: `x := _mk_none()` and a method `m.mk()` are E0613; the canaries
`(x : Option(i32)) = _mk_none()`, `_mk_none(generic(bool))` and `(z : Option(u8)) = m.mk()` run.
