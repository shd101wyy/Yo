# yo-self segfaults during where-clause trait constraint evaluation

## Status

Open. Discovered 2026-05-16 during evaluator-coverage gap-fill session
on `bootstrap/phase-4`, immediately after the forall→SomeT fix
(commit `e1caa757`) corrected the LHS resolution.

## Symptom

The yo-self bootstrap binary (`yo-self-bin check`) silently segfaults
(SIGSEGV, exit 139) when evaluating a function type that has a
`where(T <: Trait)` clause, after the breadcrumb `check: invoking
evaluate_anonymous_module_begin_exprs` is printed.

The TS reference compiler (`./yo-cli check`) handles the same source
successfully.

## Repro

```yo
// /tmp/test_forall_where.yo
id :: (fn(comptime(T) : Type, x : T, where(T <: Send)) -> T)(x);

main :: (fn() -> unit)({
  _ := id(i32, i32(42));
});
export(main);
```

```
$ ./yo-cli check /tmp/test_forall_where.yo
check: /tmp/test_forall_where.yo — evaluator OK

$ /tmp/yo-self-bin check /tmp/test_forall_where.yo
check: parsing /tmp/test_forall_where.yo
check: parsed 4 top-level exprs
check: collected 4 exprs total (deps + body); registering evaluator
check: invoking evaluate_anonymous_module_begin_exprs
$ echo $?
139
```

A reduced form without the `where(...)` clause does not crash:

```yo
my_id :: (fn(comptime(T) : Type, x : T) -> T)(x);
main :: (fn() -> unit)({ _ := my_id(i32, i32(42)); });
export(main);
```

passes `yo-self-bin check` with `evaluator OK`.

## Localization

The crash sits between two breadcrumb prints in
`yo-self/main.yo:run_check` — after
`evaluate_anonymous_module_begin_exprs` is invoked but before any
diagnostic from `_evaluate_expression_wrapper`'s throw handler is
emitted. That means either:

1. A SIGSEGV (raw C-level crash) inside the yo-self runtime
   during where-clause evaluation, OR
2. A panic without graceful unwinding that bypasses the wrapper.

The forall→SomeT fix (`e1caa757`) makes Pass 3 bind `T` to
`TypeVal(SomeT(...))`. Pass 4's where-clause LHS resolver now finds
the existing SomeT and falls through to
`parse_where_clause_constraints` → trait evaluation → constraint
attachment. The segfault is somewhere on that path.

Most likely candidates:

- `evaluate_expression_raw` on the RHS trait name (`Send`).
- `_add_where_clause_constraint` mutating `required_trait_types`.
- Some downstream codegen path on a SomeT that wasn't exercised
  before (Pass 3 used to leave T as `UnknownVal`).

## Narrowed (May 16 follow-up)

After more probing:

- `where(T <: CustomTrait)` where `CustomTrait` is **defined in the
  same file** works correctly (e.g.,
  `/tmp/test_fn_where_custom.yo` passes).
- `where(T <: Send)` segfaults — `Send` is a stdlib trait not loaded
  in env (bootstrap doesn't preload prelude).
- `where(T <: NonExistent)` (genuinely undefined identifier) also
  segfaults instead of throwing a clean `Variable "NonExistent" not
found` error.

So the trigger is: **the where-clause RHS trait identifier lookup
fails AND the resulting throw doesn't propagate cleanly**. A plain
identifier lookup failure outside where-clauses prints the clean
error and exits 134 (panic via wrapper), but the where-clause path
gives exit 139 (SIGSEGV).

Probably a yo-self codegen issue with how the exn passes through
nested raw_wrapper / inner evaluator boundaries — only triggered
on this specific control-flow shape.

## Probable relation to May-14 codegen regression

This crash has the same fingerprint as
`yo-self-bin-rebuild-segfaults-after-may14-src-codegen-changes.md`:
silent SIGSEGV with no diagnostic, only on specific code paths the
bootstrap rebuild exercises. It may be the same underlying runtime
bug surfacing through a new path.

## Next steps

1. Add per-step breadcrumbs inside `parse_where_clause_constraints`
   to pinpoint which call crashes.
2. If the crash is at the C-runtime level, compile yo-self with
   `--sanitize address` and re-run on this fixture.
3. If sanitizer flags a specific allocation, file or fix a codegen
   bug; if not, this is likely a yo-self evaluator gap (a downstream
   function that doesn't handle SomeT correctly).
