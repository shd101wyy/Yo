# An inherent impl on a `Dyn` type is accepted and registers nothing

**Status: FIXED 2026-09-25** (Phase 2.7 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: silent no-op.**

```rust
impl(AnyError, is : (fn(self : Self, comptime(T) : Type) -> bool)(match(downcast(self, T), .Some(_) => true, .None => false)));
(e : AnyError) = dyn(NotFound(path : `x`));
e.is(NotFound);   // error[E0610]: No matching call found with arguments: (e.is)(NotFound)
```

The impl passed `check`, but its methods were unreachable.

## Root cause

`type_id_or_empty` (`src/evaluator/values/type_trait_methods.yo`) had no arm for `DynT`, so a
`Dyn` type's registry id was `""` and the registration was skipped. Unions had the same gap until
they were given an id.

## Fix

A `Dyn` type's id is its sorted trait identities (`__yo_dyn(<trait ids>)`), so `Dyn(A, B)` and
`Dyn(B, A)` share one. The receiver lookup then finds inherent methods registered on the `Dyn`.
Codegen emits a direct call, because the method has no vtable slot (see
`issues/fixed/blanket-inherent-method-on-a-dyn-receiver-dispatches-through-the-vtable.md`).

`std/error.yo`'s `error_is(err, T)` was a free function only because of these two bugs. It is now
`err.is(T)`, an inherent method on `AnyError`, like Rust's `impl dyn Error`.

## Verification

`tests/error_ergonomics.test.yo` exercises `err.is(T)` (8 passed). The repro above prints
`true false` for a matching and a non-matching type.
