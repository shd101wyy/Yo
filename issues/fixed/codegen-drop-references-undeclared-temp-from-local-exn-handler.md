# Codegen `___drop` references undeclared temp when local `given(exn)` handler escapes (FIXED)

> **Fixed** in commit `d62ff8b2` (`codegen: don't emit caller-scope
consumed-var drops in ctl handler bodies`). Two related changes:
> `generateFunctionBody` now resets per-function deferred-drop state at
> the top so non-begin bodies (synthetic ctl handlers whose body is a
> bare `escape(...)`) don't inherit stale drops from the previous
> function's generation. `generateEscape` now suppresses
> `generateConsumedVarDropsForEscape` when the current function is an
> `isEffectRecordMemberFunction` — those drops were recorded against
> variables in the _caller's_ scope, not the handler body's scope, so
> emitting them inside the handler produced references to undeclared C
> identifiers. The caller's own drops still execute at the handler
> installation site after `__yo_effect_escaped` is observed.
>
> Stream A's main.yo wiring (commit `c9669a2e`) activates the real
> `try_populate_expr_info_table(...)` call on top of this fix.

## Symptom

When `yo-self/main.yo`'s `compile` subcommand calls a helper that has its
own `given(local_exn) := Exception(throw : ((_err) -> escape(...)))`
handler — specifically the Stream A `try_populate_expr_info_table`
helper that wraps `evaluate_anonymous_module_begin_exprs` — the
TS-built `yo-cli` emits a `___drop` cleanup that references an
undeclared temp variable:

```text
yo-self/yo-self-bin.c:31473:67: error: use of undeclared identifier '_yo3e987b18_temp_370876'
 31473 |   fn_yo1c2129e9_id_100393___drop((__yo_enum_yo1c2129e9_id_100378)(_yo3e987b18_temp_370876));
       |                                                                   ^~~~~~~~~~~~~~~~~~~~~~~
```

The temp name does not appear earlier in the generated C — the drop
expression refers to a name that was supposed to be the binding for
some RC value the evaluator helper consumed, but the binding's
declaration never reached the C output.

## Reproduction (minimal)

Smallest change that triggers it:

```diff
 // yo-self/main.yo, near the top of run_compile
 exprs := parse(src, input_path, using(exn));
+set_pipeline_expr_info_table(try_populate_expr_info_table(exprs.clone(), input_path));
 opt_c := compile_module_to_c(exprs, mod_id.as_str(), "main");
```

where `try_populate_expr_info_table` is:

```yo
try_populate_expr_info_table :: (
  fn(exprs : ArrayList(AstExpr), module_path : String) -> Option(ExprInfoTable)
)({
  given(local_exn) := Exception(
    throw : ((_err) -> escape(Option(ExprInfoTable).None))
  );
  env := Environment.new(module_path);
  ctx := eval_context_new(String.from(""), module_path);
  register_evaluate_expression();
  _r := evaluate_anonymous_module_begin_exprs(
    exprs, env, &(ctx), false, using(local_exn)
  );
  Option(ExprInfoTable).Some(ctx.expr_info_table)
});
```

Removing the `try_populate_expr_info_table` call (e.g. staging
`Option(ExprInfoTable).None` directly via
`set_pipeline_expr_info_table`) compiles cleanly. So the bug is
triggered by _calling_ a helper that combines:

- a local `given(exn)` handler that `escape()`s on throw,
- and an evaluator call that consumes RC-typed values
  (`ArrayList(AstExpr)`, `Environment`, etc.).

## Why this blocks Stream A's last step

Stream A's main.yo wiring is in place (commit `36b2434e`) but stages
`Option(ExprInfoTable).None` rather than calling
`try_populate_expr_info_table(...)`. The metadata-aware per-handler
codegen ports (`typeid.yo`, `panic.yo`, `open.yo`, `binding.yo`) will
keep falling through to bootstrap heuristics until this is fixed.

## Likely fix area

`src/codegen/exprs/drop-dup.ts` and `src/codegen/exprs/return.ts` —
both write deferred `___drop` expressions that reference temp
variables from the enclosing scope. When the temp's defining
expression is captured inside a `given(exn)` body that may `escape`,
the codegen seems to emit the drop in the outer scope (where the temp
is not visible).

A workaround until this is fixed: stage `.None` in main.yo and let
the codegen continue on the bootstrap heuristic path. This is what
the current commit does.
