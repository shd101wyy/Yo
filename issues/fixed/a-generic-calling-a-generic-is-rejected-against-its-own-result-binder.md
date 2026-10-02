# A generic calling a generic is rejected against its own result binder

**Severity:** S2. A valid generic is rejected by `check` and `compile` with `Expected: U,
Given: U`, whether it is ever called or not.

**Status:** FIXED 2026-10-02 on branch `tss/phase6-reraise`. Found while probing shapes for
Phase 6 step 3 of `plans/TYPE_SYSTEM_SOUNDNESS.md`.

## Reproducer (measured, develop `aa772c3c9` and the v0.2.48 seed)

```rust
{ println } :: import("std/fmt");
twice :: (fn(generic(T : Type), x : T) -> T)((x + x));
wrap :: (fn(generic(U : Type), u : U) -> U)(twice(u));
main :: (fn() -> unit)({
  println(wrap(i32(4)));
});
export(main);
```

```
error[E0604]: Incompatible function return type for:
- Expected: U
- Given  : U
  --> main.yo:3:39
```

`twice(i32(4))` called directly compiles and prints 8. The error needs all three parts:

- an operator on the unconstrained binder (`x + x`, `x * x` and `x == x` all reproduce;
  `-(x)` and a `where(T <: Add(T))` bound do not);
- a caller that passes its own binder (`twice(u)` inside a generic);
- a caller whose result is that binder (`-> U`; `-> i32` does not reproduce).

Declaring the intermediate (`(r : U) = twice(u); r`) fails the same way.

## Root cause

`twice`'s definition-time trial types `x + x` as `unit`: no operator impl is found for an
unconstrained `T`, and the call falls through to the soft path
(`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`). The trial accepts that
(`dg_trial_degenerate`), but the id-preserving trial clone leaves `unit` stamped on the
body's node.

`wrap`'s trial calls `twice(u)` with `T := U`, where `U` is `wrap`'s own unbound binder.
`_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) then runs the bridge
written for an opaque `Impl(...)` result. It adopts the callee body's definition-time type as
the result's resolution, and it does so for every SomeT result. The call's type became
`SomeT U` resolved to `unit`. `type_contains_some_type_for_codegen_param` follows the
resolution, so the deferred-generic result check judged the body concrete and rejected it
against `U`.

## Fix

A result that is the caller's own unbound binder (`_fv_type_vars_are_callers_binders`) takes
no resolution from the callee's body. That binder is rigid in the caller's trial, and a
callee body's type cannot resolve it. The same guard is applied to the twin bridge after
the specialization is minted. That bridge already skipped a `unit` body, but nothing else
stopped a body type from resolving the caller's binder there. An opaque `Impl(...)` result
is not a caller binder, so it keeps the bridge.

## Test

`tests/type_soundness.test.yo`, "soundness: a generic forwarding its binder to an operator
generic". On develop the whole file fails to check with the E0604 above.
