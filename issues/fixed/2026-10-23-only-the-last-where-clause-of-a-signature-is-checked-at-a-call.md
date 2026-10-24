# Only the last `where` clause of a function signature is checked at a call

**Severity:** S2 — a bound written in any `where(...)` clause but the last is never checked at a call, so a call with a type that lacks it is accepted

**Status:** fixed on `fix/b8bug-rawview-generic` (2026-10-23).

Found while reviewing the raw-view owner exemption
(`issues/fixed/2026-10-22-the-raw-view-gate-rejects-a-generic-buffer-owning-value-parameter.md`).
The exemption reads a parameter's declared bounds, and a bound in an earlier
`where` clause was missing from them.

## Repro

```yo
{ println } :: import("std/fmt");
NC :: struct(x : i32);
f :: (fn(generic(T : Type), a : T, where(T <: Clone), where(T <: Send)) -> i32)(i32(1));
main :: (fn() -> unit)({
  println(f(NC(x : i32(1))));
});
export(main);
```

With the v0.2.68 seed this compiles and prints `1`, although `NC` has no
`Clone`. Written as one clause, `where(T <: (Clone, Send))`, the call is
rejected: `error[E0602]: Type NC does not implement required trait Clone.`
With the clauses reversed, `where(T <: Send), where(T <: Clone)`, the call is
rejected too. Only the last clause counted.

A body that uses the dropped bound (`a.clone()`) did fail, but inside the
instantiated body (`E0610: No method "clone" on NC`), not at the call. A
bound the body does not use was not checked at all.

The same loss showed in the raw-view gate's view of the parameter: in
`fn(generic(T : Type), b : &CBuf(T), where(T <: Clone), where(T <: Send))`,
the annotation's `T` carried only `Send`.

## Root cause

The signature's clause-zone check (`evaluate_function_parameters`, pass 2b,
`src/evaluator/types/function.yo`) admits several `where(...)` clauses, since
zones only need to be non-decreasing. Pass 4, which collects the where
constraints into `where_clause_exprs` and applies them to the type
variables, looked only at the last non-contract parameter. Every earlier
`where(...)` was skipped: pass 5 skips where clauses as already processed.
`where_clause_exprs` is what the function type stores and what a call
re-applies, so the earlier clauses' bounds were lost everywhere downstream.

## Fix

Pass 4 now collects the constraints of every `where(...)` clause in the
signature, in order. A clause with no constraint is still rejected with "The
where clause must have at least one constraint." Several clauses are now the
same as one clause listing all their constraints.

Trait definitions are not affected: `trait(...)` requires its single `where`
clause to be the last argument.

**Test:** `tests/where_clause_fn_inference.test.yo`. `_wc_need_both_split`
declares `where(T <: _WcBar), where(T <: _WcFoo)`. A call with a type that has
only `_WcFoo` must fail with "does not implement required trait _WcBar". The
seed gives `No method "wc_bar"` from the instantiated body instead, so the
message check fails. A type with both traits still runs.
`tests/raw_view_generic_owner.test.yo` covers the raw-view side with
`_rv_cloned_split` and `_rv_cloned_split_rev`.
