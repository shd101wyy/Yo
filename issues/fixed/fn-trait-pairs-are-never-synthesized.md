# Two `Fn` traits are never synthesized against each other, and `Dyn` has no synthesis case

**Status: FIXED 2026-09-25** (Phase 2.6 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).

**Severity: inference gap that ended in an ICE.** A binder that appears only
inside a `Dyn(Fn(...))` parameter was never inferred from the argument:

```rust
{ println } :: import("std/fmt");
_apply_dyn :: (fn(generic(A : Type, B : Type), f : Dyn(Fn(x : A) -> B), v : A) -> B)(f(v));
main :: (fn() -> unit)({
  (inc : Dyn(Fn(y : i32) -> i32)) = dyn(y => (y + i32(1)));
  println(_apply_dyn(inc, i32(41)));
});
export(main);
```

The v0.2.41 seed stops with `internal compiler error: Failed to transpile part
of main's body`. With Phase 2.4's E0613 in place the same program was
rejected: `Cannot infer the type parameter "B" of this call`. Expected output:
`42`.

**Found** 2026-09-25 while making `where(F <: (Fn(item : A) -> J))` bind `J`
from a closure argument (Phase 2.6): synthesizing the parameter's `Fn` bound
against the closure's bound bound nothing.

## Root cause

Two holes in `src/evaluator/types/synthesizer.yo`, `_synthesize_types_impl`:

1. **The TraitT case caught the Fn and Future pairs.** `is_trait_type` is
   true for `TraitT`, `FnTraitT` and `FutureTraitT`. The "TraitT + TraitT"
   case came first. It read both sides' trait ids (empty for the two
   structural variants, so "equal"), walked the `TraitT` field types (none),
   and returned. The dedicated "FnTraitT + FnTraitT" and
   "FutureTraitT + FutureTraitT" cases below it were dead code. The SomeT arms
   call `_synthesize_fn_traits` directly, which is why an `Impl(Fn(...))`
   parameter still inferred.
2. **No `Dyn` case.** A `DynT` pair matched no case at all, so nothing inside
   `Dyn(...)` was ever synthesized.

## Fix

- The Future and Fn pair cases now come before the TraitT case.
- A new "Dyn + Dyn" case synthesizes each expected trait against the given
  trait of the same kind: the same Fn base, a Future, or the same trait id.

## Verification

- The reproducer prints `42`.
- `tests/type_soundness.test.yo`, "soundness: Dyn(Fn(x : A) -> B) binds A and
  B from the argument". It fails on the seed and passes after the fix.
