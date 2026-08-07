# yo-self: `__yo_expr_eq(quote(x), quote(x))` is FALSE inside a macro body (TS: true)

Status: FIXED (2026-07-17). Root cause was NOT in the expr_eq/quote path at
all: `yo-self/evaluator/index.yo`'s `Evaluator.new` evaluated modules through
the LEGACY `evaluate_module_body` flat walker (eval.yo) with no EvalContext —
TS's `Evaluator.evaluateProgram` drives the real
`evaluateAnonymousModuleBeginExprs` with `isExecuting: true`. Under the
legacy walker the macro-body `cond` condition never even reached the
`__yo_expr_eq` builtin dispatch (probe in `evaluate_yo_expr_eq` never fired),
so the else arm was taken. Fix: rewrite `Evaluator.new` to mirror TS —
`eval_context_new` + `is_executing = true` + `ctx.load_module` bridged to the
user loader (g_demand_loader pattern) + `evaluate_anonymous_module_begin_exprs`;
`module_value`/`module_error`/`env` now come from its `AnonModuleResult`.
This also fixed the second oddity recorded below (module-level variant's
`get_module_value()` returning None). `phase6f_macro_helpers.test.yo` test 1
re-enabled (`if(MACRO_DISPATCH_ENABLED, ...)`); standalone differential gives
`v = IntLit(1)` with both args ExprVal.

_(historical record below)_

## Differential (the TS oracle)

```rust
pragma(Pragma.SkipPrelude);
is_same :: (fn() -> unquote(Expr))(cond(__yo_expr_eq(quote(x), quote(x)) => quote(true), true => quote(false)));
v :: is_same();
comptime_assert(v);
export(v);
```

- TS (`./yo-cli check`): passes — and the negative control (`quote(x)` vs
  `quote(y)`) correctly FAILS the assert, so the pass is not vacuous.
- yo-self proper Evaluator (`Evaluator.new` with SkipPrelude + noop loader,
  driven from a `*.test.yo` harness): the same macro yields the FALSE arm —
  `v = IntLit(0)` in the quote(1)/quote(0) variant (probe output).

## What is already ruled out

- `eval_value_eq`'s ExprVal Atom equality (`yo-self/value.yo` ~:513) is
  correct: compares `atok.value == btok.value` — two `quote(x)` Atoms would
  compare TRUE if they reached it.
- `are_values_equal` (`yo-self/evaluator/utils.yo:1302`) routes two concrete
  values to `val1 == val2` → the EvalValue Eq impl → `eval_value_eq`. Fine.
- `evaluate_yo_expr_eq` (`yo-self/evaluator/builtins/expr_fns.yo:513`)
  mirrors TS expr-fns.ts:375+: evaluates both args, requires Expr type +
  value, compares with `are_values_equal` when BOTH values are ExprVal, else
  produces `UnknownVal(bool)`.

So the false comes from upstream: inside the macro body, the evaluated
`quote(x)` args either don't carry ExprVal values (→ UnknownVal(bool), and
the `cond` then takes the else arm) or carry something that isn't an
`.Atom`. The TS run proves the same source populates real ExprValues.

## Probe history (2026-07-16)

- Harness probe (`Evaluator.new`, macro variant with quote(1)/quote(0)):
  module evaluates cleanly, `v = IntLit(0)`.
- Module-level (no macro) variant `v :: __yo_expr_eq(quote(x), quote(x));`
  under the same harness: `get_module_value()` returns None entirely — a
  second, possibly related oddity in exporting the bool result.

## Next steps

1. Instrument `evaluate_yo_expr_eq` to log which branch fires (is_expr_val
   on both? unknown?) when driven from the macro body — cheapest via a
   temporary println (the file already imports enough; keep probes
   single-expression).
2. If the values are UnknownVal: trace where the macro-body arg eval of
   `quote(x)` loses the ExprVal — compare with TS `evaluateExpression` of a
   quote call in a comptime fn body (`src/evaluator/builtins/quote.ts` /
   `expr-fns.ts`), likely a ctx flag (`is_executing` /
   force_compile_time_bindings) divergence in the macro-execution path
   (`MACRO_DISPATCH_ENABLED` call path in `evaluator/calls/function.yo`).
3. Fix faithfully, flip the phase6f test 1 gate back to
   `MACRO_DISPATCH_ENABLED`, run `./yo-cli test
yo-self/tests/phase6f_macro_helpers.test.yo --parallel 1` → 3/3.
