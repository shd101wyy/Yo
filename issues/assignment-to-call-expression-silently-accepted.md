# Assignment to a call expression is silently accepted (check AND runtime)

**Found 2026-08-18** during the ExprInfo diet refactor (perf/exprinfo-diet).

## Symptom

```rust
expr_info_runtime_arg_exprs_in_order(out_info) =
  Option(ArrayList(AstExpr)).Some(call_result.runtime_arg_exprs_in_order);
```

The LHS is a **function call**, not a place. Both compilers accepted this:

- `check ./yo-self` passed 248/248 with this line present
  (yo-self/evaluator/exprs/recur.yo:221 at the time).
- The compiled compiler ran it silently as a no-op — the RHS value was
  discarded, `runtime_arg_exprs_in_order` never stored, and the failure
  surfaced only much later as `yo: error: No arguments for recur call`
  during a self-emit, plus FIXPOINT_BROKEN and 7 gates_fast failures.

## Expected

`<call-expr> = <value>` where the callee is not an Index-trait place or
another recognized lvalue form should be a hard evaluator error ("cannot
assign to a function call"), at check time.

## Why it matters

The failure mode is maximally silent: no diagnostic at check, no diagnostic
at runtime, wrong behavior arbitrarily far downstream. A mechanical refactor
(field write → accessor call) can manufacture exactly this shape, which is
how it was found.

## Repro sketch

```rust
f :: (fn(x : i32) -> i32)(x);
main :: (fn() -> unit)({
  f(1) = 2; // should be a check error; today it is silently evaluated
});
export(main);
```

(Verify the minimal shape — the found instance had a unit-returning callee
on the LHS; the discard behavior may depend on the `=` dispatch path.)

## Next steps

- Add a `comptime_expect_error` test for the minimal repro.
- Fix in the `=` evaluation path (both compilers): reject call-expression
  LHS unless it resolves to an Index-trait place (`arr(0) = v`) or another
  sanctioned lvalue form.
