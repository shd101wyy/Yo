# A call whose generic result cannot be inferred passes `check` and ICEs in `compile`

**Found:** 2026-09-23, type-system audit (`plans/TYPE_SYSTEM_SOUNDNESS.md`, Phase 2).
**Status:** OPEN. Green `yo check`, internal compiler error in `yo compile`.
**Measured:** yo 0.2.39 seed.

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
