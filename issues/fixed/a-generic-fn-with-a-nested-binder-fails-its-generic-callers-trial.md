# A generic fn whose binder sits under a pointer fails its generic caller's trial

**Severity:** S3. The caller's definition-time trial failed and the error was swallowed.
Every concrete specialization worked, so nothing was reported. Phase 6 step 3 of
`plans/TYPE_SYSTEM_SOUNDNESS.md` (re-raise a swallowed trial error) would have turned it into
a false error in user code.

**Status:** FIXED 2026-10-01 on branch `tss/generic-extern-trial`. Found by the
adversarial review of the fix for
`issues/fixed/a-generic-extern-called-from-a-generic-impl-member-fails-its-trial.md`. That doc
had claimed that a Yo-fn callee passes, but it passes only when the callee returns `unit`.

## Reproducer (measured, v0.2.48)

```rust
pragma(Pragma.AllowUnsafe);
id_ptr :: (fn(generic(U : Type), a : *U) -> *U)(a);
forward :: (fn(generic(T : Type), a : *T) -> *T)(id_ptr(a));
export(forward);
```

```
$ YO_DEBUG_SWALLOW=1 yo check main.yo
[swallow] error[E0613]: Cannot infer the type parameter "U" of this call: it appears in the
result type *(U), and neither an argument nor the expected type determines it.
```

A `-> Pair(*U, *U)` result fails the same way. So does the prelude's `GcTracer.visit` shape,
a generic impl member calling a generic Yo fn `-> *T`. With a whole-type parameter
(`a : U`), the trial passes. `forward(&x)` with `x : i32` compiles and runs.

## Root cause

A callee with a `FuncVal` (a Yo fn, not an `extern`) binds its `generic(...)` binders in
`_funcval_bind_foralls` (`src/evaluator/calls/function.yo`), not in the parameter check.

- A binder that IS a parameter type (`a : U`) binds by name to the argument's type,
  whatever that type is. In a trial that is the caller's rigid `T`.
- A binder nested in a parameter type (`a : *U`) is reached only by the structural fallback.
  That fallback synthesizes `*U` against `*T` into a scratch env and gets `U := T`. It then
  bound `U` only when the result was free of type variables (`type_contains_some_type_deep`).

The comment there said so: in a trial the caller's binder "is unbound, resolves to itself,
and is rejected below as before". `U` stayed unbound. The FuncVal arm's E0613 check
(`unresolved_own_binder` on the result type) then found the callee's own `U` in `*(U)` and
threw.

## Fix

The structural fallback also binds when every unresolved type variable in the synthesized
type is a binder the caller has in scope and has not bound: its name is a variable of the
caller env whose value is that same SomeT (same id) with no resolution
(`_fv_type_vars_are_callers_binders`). That is the binding the name-match arm already makes
for `a : U`. A fresh placeholder, such as a `.None` literal's payload variable, or any
SomeT that is not a caller binder, is still left to the capture and receiver fallbacks as
before. Inside a concrete specialization the caller's binder has a value, so the existing
concrete branch handles it as before.

## Verification

- `tests/cli-cases/check-generic-fn-with-a-nested-binder-called-with-a-callers-binder`:
  `check` under `YO_DEBUG_SWALLOW=1` of `-> *U` and `-> Pair(*U, *U)` callees and the
  impl-member shape. The golden pins that no swallowed error points into `main.yo`.
  - Red before: the seed (v0.2.48) prints three E0613 swallows (`main.yo:10:50`,
    `main.yo:11:65`, `main.yo:16:72`).
  - Green after: the fixed build prints none.
