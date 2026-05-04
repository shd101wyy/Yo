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

The `==` operator for `Expr` is defined in `std/prelude.yo` (lines 4004-4008)
via `impl(Expr, ComptimeEq(Expr)(...))` which delegates to `__yo_expr_eq`.
When tests use `// @skip_prelude`, this impl is NOT loaded, so `==` between
two `Expr` values falls back to something that does not perform structural
comparison.

The fix is therefore **not** a new dispatch arm — the routing already exists
via trait resolution. It requires either:
(a) Wiring the proper Evaluator to load the real `std/prelude.yo` (Phase 6e
prelude auto-loading), OR
(b) Loading a minimal stub prelude that defines just the `Expr` Eq impl.

The `__yo_expr_eq` builtin path itself works correctly (and now uses the new
Atom equality in `eval_value_eq` for `value.yo`).

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

Implement Phase 6e: prelude auto-loading. The Evaluator already supports it
(see `yo-self/evaluator/index.yo:128-161`); we just need a `load_module_fn`
that returns the parsed/evaluated `std/prelude.yo` (or a minimal subset
defining `Expr` and its `Eq` impl).

Short-term workaround for tests: skip the test or use `__yo_expr_eq` directly.

## Status

Discovered while implementing Phase 6f (gensym, `.car`/`.cdr`, ExprVal Atom
equality). Test 1 in `yo-self/tests/phase6f_macro_helpers.test.yo` is
skipped pending a fix. Tests 2 and 3 (gensym, cdr) pass.

This dispatch is required for the real `std/prelude.yo` `for` macro, which
uses `e.get_callee() == quote(=>)` to detect arrow callbacks. Until this
is fixed, the divergent built-in `for` 3-arg handler in the proto-evaluator
must remain.
