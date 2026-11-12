# A self-recursive generic function crashes the checker with unbounded specialization

**Severity:** S1. A generic function that calls itself at the same instantiation —
`deep :: (fn(generic(T : Type), n : usize, v : T) -> T)(cond((n == usize(0)) => v, true => deep(n - usize(1), v)))`
called once from `main` — kills `yo check` with SIGSEGV (rc 139), a compiler crash on a valid four-line program.
`YO_MAIN_STACK_MB=4096` does not help: the recursion is unbounded. Pre-existing: v0.2.76 crashes the same way.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 B1). Confirmed on develop `64f33c710`. No open issue
describes it; `issues/fixed/mutual-recursion-between-a-fn-and-a-trait-impl-body.md` and
`issues/fixed/yo-self-recursive-generic-type-identity-p3.md` are different shapes (mutual recursion through an
impl, recursive generic TYPES).

## Reproducers

`issues/repros/2026-11-11-a-self-recursive-generic-function-crashes-the-checker-with-unbounded-specialization.yo`
(expects accept, `OUT: 5`):

```yo
{ println } :: import("std/fmt");
deep :: (fn(generic(T : Type), n : usize, v : T) -> T)(
  cond((n == usize(0)) => v, true => deep(n - usize(1), v))
);
main :: (fn() -> unit)({
  x := deep(usize(3), i32(5));
  println(`OUT: ${x.to_string()}`);
  ()
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: rc=139 (SIGSEGV), no diagnostic.  v0.2.76: rc=139
$ YO_MAIN_STACK_MB=4096 yo check repro.yo   # rc=139
```

- `…-mut.yo` (expects accept): `deep(generic(T), n, dst : &mut Option(T), v : T) -> unit` storing at the bottom;
  the same crash, so the result type plays no part.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| generic `deep` recursing through a `cond` arm | rc 139 | accept |
| the same with an early `if(…, { return(v); })` and a tail call (ledger: n02d) | rc 139 (also at `YO_MAIN_STACK_MB=4096`) | accept |
| `deep(…, dst : &mut Option(T), v : T) -> unit` at `T := i32`, and at `T := H` a holder (ledger: n02) | rc 139 | accept (E0911 for the holder over a block local) |
| the same function without `generic(T)` (`v : i32`) | accepted, `OUT: 5` | accept |

## Root cause

A backtrace (`gdb -batch -ex run -ex bt`) of the crash is 353,000 frames deep and repeats one 17-frame cycle. Its
named links are `_evaluate_funcval_runtime_call` (`src/evaluator/calls/function.yo`) → `create_specialization_at_call`
→ `create_specialized_function_inline` (`src/evaluator/calls/helper.yo`) → the specialization's body
(`evaluate_begin_expression` / `_evaluate_begin_expression_impl`, `src/evaluator/exprs/begin.yo`) → the call `deep(…)`
in that body → `_evaluate_funcval_runtime_call` again. Each specialization of `deep` at `T := i32` mints a new one.

Two guards exist and neither covers this route. `create_specialized_function_inline` looks up
`_find_specialization_cache` first, but `_store_specialization_cache` runs only after the body has been evaluated, so
an in-progress specialization is not in the cache. It does push the in-progress specialization onto
`ctx.currently_specializing_function` / `currently_specializing_function_stack` before evaluating the body, and
`try_to_call_function_with_arguments` (`helper.yo`) reads them (`is_recursive_spec` for direct recursion,
`_find_mutual_specializing_info` for mutual recursion) to reuse the in-progress specialization's id. The Gap-6 arm of
`_evaluate_funcval_runtime_call`, which this call takes, calls `create_specialization_at_call` without consulting
either.

## Expected

Accept; `OUT: 5` at run time. A call to a function that is being specialized at the same instantiation (same
`original_func_id`, same `impl_bindings_sig`, same argument types) refers to the in-progress specialization's id
instead of minting a new one, on every call route, as `try_to_call_function_with_arguments` already does.

## Test

With the fix: both programs as cases in `tests/generic_instantiation_compat.test.yo` (or a new
`tests/generic_recursion.test.yo`), each `deep` checked, compiled and run to `OUT: 5`, with a second instantiation (`T := String`) beside the
first so a cached id is not shared across instantiations.
