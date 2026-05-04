# Proper Evaluator: `==` between two `Expr` values does not dispatch to `__yo_expr_eq`

## Symptom

In a comptime context, comparing two `Expr` values with `==` always returns
`false` (or unknown), even when the underlying ASTs are structurally equal:

```rust
// @skip_prelude
is_arrow :: (fn(quote(e) : Expr) -> unquote(Expr))
  cond((quote(x) == quote(x)) => quote(1), true => quote(0));
v := is_arrow(a => b);
export v;  // expected: 1, actual: 0
```

The same comparison routed through the `__yo_expr_eq` builtin works correctly
(now that `eval_value_eq` in `yo-self/evaluator/value.yo` does structural
Atom-token equality on `ExprVal`).

## Root cause

`yo-self/evaluator/builtins/expr_fns.yo:451` only fires when the AST already
contains a literal call to the builtin `__yo_expr_eq`. When the user writes
`expr1 == expr2`, the parser emits `==(expr1, expr2)`, and the proper
Evaluator's call dispatcher in `yo-self/evaluator/exprs/_expr.yo` does not
recognize this as an Expr equality. The TS reference handles this through
operator/trait dispatch in `src/value.ts:areValuesEqual` (lines 948-951)
which delegates to `exprsAreEqual`.

## Files involved

- `yo-self/evaluator/exprs/_expr.yo` — call dispatcher (no Expr-typed `==`
  arm).
- `yo-self/evaluator/builtins/expr_fns.yo` — `evaluate_yo_expr_eq`
  implementation, only reached via `__yo_expr_eq` builtin call.
- `yo-self/evaluator/utils.yo:847` — `are_values_equal`, which would
  delegate to `eval_value_eq` for ExprVal.
- `yo-self/evaluator/value.yo:521-531` — `eval_value_eq` ExprVal Atom
  equality (Phase 6f, now correct for Atoms).

## Fix sketch

Add an arm in the call dispatcher (or in the binop evaluation path) that,
for `==` with both operands typed as `Expr`, rewrites or directly invokes
`evaluate_yo_expr_eq`. Alternatively, route all `==` calls through
`are_values_equal` when both operand types are comptime/Expr.

## Status

Discovered while implementing Phase 6f (gensym, `.car`/`.cdr`, ExprVal Atom
equality). Test 1 in `yo-self/tests/phase6f_macro_helpers.test.yo` is
skipped pending a fix. Tests 2 and 3 (gensym, cdr) pass.

This dispatch is required for the real `std/prelude.yo` `for` macro, which
uses `e.get_callee() == quote(=>)` to detect arrow callbacks. Until this
is fixed, the divergent built-in `for` 3-arg handler in the proto-evaluator
must remain.
