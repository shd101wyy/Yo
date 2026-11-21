# Partial application through a generic binder loses the compile-time result

**Severity:** S1 — a valid program that partially applies a comptime function whose result is typed by a `generic(...)` binder fails with an internal compiler error (E1301) when the result is used at run time (an ICE on valid input is S1 on the `issues/README.md` scale).

Found 2026-11-21 while verifying `.github/instructions/testing.instructions.md` ("Partial application (`_`)")
with the v0.2.78 tree binary (`cut-g4-final`).

## Reproducer

```yo
{ println } :: import("std/fmt");
Wrap :: (fn(generic(A : Type), comptime(x) : A, comptime(y) : A) -> comptime(A))(x);
g :: Wrap(i32(7), _);
r :: g(i32(9));
main :: (fn() -> unit)({
  (v : i32) = r;
  println(&v);
});
export(main);
```

`yo compile` fails:

```
error[E1301]: internal compiler error: Failed to transpile part of main's body — the emitted C for "__yo_user_main" contains an untranspiled expression, so the program would run without it
```

## Observations

- The full call `Wrap(i32(7), i32(9))` compiles and runs.
- With concrete parameters (`fn(comptime(x) : i32, comptime(y) : i32) -> comptime(i32)`), the same partial
  application folds: `comptime_assert(g(i32(9)) == i32(7))` passes.
- With the generic binder, `comptime_assert(r == i32(7))` fails with E1101 ("Expected bool value"): `r` has
  type `i32` (`(v : i32) = r` type-checks) but no compile-time value, so the binder `A` is presumably left
  unresolved when the partial application's remaining slot is filled.
- A `_` in a generic parameter's position is rejected as intended ("Partial application: expected 2
  argument(s), got 3"): generic parameters are inferred, not positional.

## Root cause

The partial-application arm of the inline FuncVal call (`src/evaluator/calls/function.yo`, "Partial
application with `_` placeholder") mints a new comptime function whose hole parameters and result are
the callee's parameter and result types, copied verbatim. For a generic callee those types name the
callee's binder (`A`), but the minted function had no binders of its own (`forall_names` empty, no
`forall_types`) and nothing substituted `A`. The binder was therefore a type variable that no call of
the minted function could bind: calling it returned an unknown of the unresolved `A` instead of the
comptime value. The type of `r` was still assignable to `i32`, so `check` passed and the hole surfaced
only in codegen (E1301).

The result type is what matters. With only a hole typed by `A` and a concrete result
(`fn(generic(A : Type), comptime(x) : i32, comptime(n) : A) -> comptime(i32)`, `F(i32(7), _)`), the
seed already folded the call. Any result typed by `A` failed: `A` fixed by the captured argument
(the reproducer), by the hole only (`fn(generic(A : Type), comptime(x) : i32, comptime(y) : A) ->
comptime(A)`), or by two holes (`Wrap(_, _)`).

## Fix

`_partial_application_binders` (`src/evaluator/calls/function.yo`) closes the minted signature over
the callee's binders. It infers the captured arguments against their parameters through the same
`_funcval_bind_foralls` a call uses, with the holes contributing nothing. A binder fixed to a concrete
type is substituted into the hole types and the result (`Wrap(i32(7), _)` is `fn(&i32) ->
comptime(i32)`). Every other binder stays a binder of the minted function (its `forall_names`,
`forall_types` and `forall_labels`), and a hole spelled by that binder carries the name as its
`param_type_names` entry, so a call of the minted function infers the binder from its hole arguments
the way the callee would. Captured arguments that disagree on a binder report a call's binder-conflict error at the partial
application.

Regression test: `tests/fn.test.yo`, "Partial application through a generic binder". It covers the
reproducer, a concrete-parameter control, a binder only the hole names (used at run time and as an
`Array` length), two holes, a result binder only the captured argument names, and the E1101
rejection of a runtime argument at a hole. Every result is read at run time, because a
`comptime_assert` inside a test body passes on an unknown value (the vacuity tracked in
`issues/yo-self-ctfe-nested-fn-analysis-gap.md`). The test fails the batch build on the pre-fix
compiler.
