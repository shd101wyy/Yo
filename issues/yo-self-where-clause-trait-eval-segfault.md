# yo-self segfaults during deep type-expression evaluator throws

## Status

**Fixed for the primary case** (commit `28c95b8e`) — codegen now
includes implicit (using-) params in fn-pointer cast signatures.

`where(T <: UnknownTrait)`, missing identifier in deep type-expr
evaluation, and other patterns where the throw propagates through
the `g_evaluate_expression_raw` fn-pointer slot now produce a clean
error (exit 134 via wrapper panic) instead of SIGSEGV.

Some related segfaults remain (recursive-generic forward refs,
nested type-app in impl return) — those go through different call
shapes and may have separate root causes; tracked as
`yo-self-nested-typeapp-in-impl-return-segfault.md`.

### History

Originally observed 2026-05-16 on `where(T <: Send)` constraint
evaluation; further narrowed the same day; root-cause investigation
and codegen fix 2026-05-16 PM.

## Summary

`yo-self-bin check` SIGSEGVs (exit 139) when an evaluator `exn.throw`
is invoked deep inside a nested type-expression evaluation chain.
The crash is **in the `exn.throw` call itself**, before any handler
runs. A fresh `given(local) := Exception(...)` handler at the same
throw site works perfectly — so the throw _mechanism_ is fine; the
**propagated `using(exn)` is broken** by the time it reaches the
deep call site.

The same throw idiom works from shallow positions (e.g. function-
parameter type evaluation reached via `_eval_and_update_env →
evaluate_expression`).

## Surfaces

The same underlying bug surfaces in several patterns:

- `where(T <: UnknownTrait)` — RHS trait identifier not in env
- `LL(T)` inside its own definition body (recursive forward ref)
- `((self) -> match(...))` impl-method shorthand needing
  inferred fn type (this case throws "Anonymous function: no
  expected type in context" which segfaults rather than printing)
- Nested type-app `Wrap(Wrap(P, i32), i32)` in impl return type

All segfault at `exn.throw(dyn(format_error_message(...)))` deep in
the evaluator.

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
$ /tmp/yo-self-bin check /tmp/test_forall_where.yo
check: invoking evaluate_anonymous_module_begin_exprs
$ echo $?
139
```

TS reference handles the same source successfully.

A reduced form without the `where(...)` clause does not crash:

```yo
my_id :: (fn(comptime(T) : Type, x : T) -> T)(x);
main :: (fn() -> unit)({ _ := my_id(i32, i32(42)); });
export(main);
```

## Investigation timeline (May 16 PM)

1. **Wrapper / main handler breadcrumbs:** added `eprintln`s to both
   `_evaluate_expression_wrapper` (the local-exn-installing wrapper
   at `yo-self/evaluator/exprs/_expr.yo:817`) and `main`'s outer
   exn handler. Confirmed _neither_ handler is reached on the deep
   throw — crash happens before any handler runs.

2. **Throw-site breadcrumbs in `identifier_and_operator.yo`:** added
   breadcrumbs around the "Variable not found" throw site. Confirmed
   `format_error_message(...)` builds successfully, then crash is
   exactly at `exn.throw(...)`.

3. **Local-handler diagnostic:** at the same throw site, installed
   a fresh `given(local_diag) := Exception(throw : ((_err) -> {
eprintln(...); panic(...) }))` and invoked `local_diag.throw(
dyn(err_msg))` instead of the propagated `exn`. The local handler
   **runs cleanly** — eprintln + panic produce a clean exit 134:

   ```
   [ident:entry] "Type"
   [where-clause:entry]
   [where-clause:loop-iter]
   [where-clause:before-eval-trait-rhs]
   [ident:entry] "UndefinedThing"
   [ident:var-lookup] "UndefinedThing"
   [ident:var-lookup-result] count=0
   [ident:about-to-throw-not-found:1]
   [ident:about-to-throw-not-found:2-built-msg]
   [ident:local-diag-handler-entered]   ← fresh handler runs
   [ident:local-diag-panic]
   exit: 134
   ```

   But replacing `local_diag.throw(...)` with `exn.throw(...)` (the
   propagated using-param) gives SIGSEGV (exit 139) at the same
   point.

4. **Conclusion:** the throw mechanism works. The propagated
   `using(exn)` value reaching the deep call site is corrupt
   (the closure's vtable / fn-pointer / environment dereferences
   into invalid memory). The shallow throw case works because the
   immediately-enclosing wrapper's just-installed exn is still
   valid at the (shorter) call site.

## Likely root cause

`using(exn)` is propagated through:

1. The `g_evaluate_expression_raw` function-pointer dispatch in
   `yo-self/evaluator/exprs/expr.yo:68`.
2. Multiple `evaluate_expression_raw(..., using(exn))` calls
   in the type-expression evaluators.

One of these layers is dropping / aliasing the Exception value so
the closure's environment pointer becomes invalid by the time the
deep call site dereferences it.

Concretely:

- **Works:** shallow throw — `evaluate_function_parameter →
_eval_and_update_env → evaluate_expression(...)` — the wrapper
  call here is one level deep.
- **Crashes:** deep throw — `init_assignment → evaluate_expression
(installs wrapper) → _evaluate_expression → evaluate_function_call
→ evaluate_expression (installs wrapper) → _evaluate_expression →
evaluate_function_type → evaluate_function_parameters →
parse_where_clause_constraints → evaluate_expression_raw → ... →
identifier_and_operator` — the wrapper's exn has to flow through
  many `using(exn)` boundaries (including the fn-pointer dispatch)
  to reach the throw site.

## Next steps

1. Compare yo-self codegen for `using(...)` parameter handling
   against the TS reference. Check whether the
   `Exception` struct (which contains a function-value closure)
   is being copied / moved / Rc'd through the using-param chain
   correctly.
2. Specifically inspect the C output for `evaluate_expression_raw`'s
   function-pointer-dispatched call site (`g_evaluate_expression_raw`)
   — does the C code pass `exn` by value, by pointer, or with an
   RC increment? Compare against a working shallow chain.
3. If the fn-pointer dispatch is the culprit, consider replacing
   `g_evaluate_expression_raw` with a direct call to
   `_evaluate_expression_raw_wrapper` (or short-circuit through
   `_evaluate_expression` directly) to verify.

## Probable relation to May-14 codegen regression

This crash has the same fingerprint as
`yo-self-bin-rebuild-segfaults-after-may14-src-codegen-changes.md`:
silent SIGSEGV with no diagnostic, only on specific control-flow
paths the bootstrap rebuild exercises. They are likely the same
underlying `using()` propagation bug surfacing through different
call shapes.

## Workaround

For tests that hit this path, replace `exn.throw(...)` at the deep
site with a freshly-installed local `given(local) := Exception(...)`
handler — that works correctly. This is not a fix; just a way to
unblock specific evaluator paths that need to throw clean errors
while the underlying codegen bug is being investigated.
