# yo-self: explicit call-site `generic(...)` type application is not ported

Status: OPEN

## Symptom

```rust
echo :: (fn(generic(T : Type), x : T, where(T <: Runtime)) -> T)(x);
v := echo(generic(i32), i32(7));
```

Under s1:

```
Error: Argument count mismatch: expected 1, got 2
```

Under TS: accepted. Dropping the explicit type argument (`echo(i32(7))`, i.e.
letting inference bind `T`) works under both.

Inside a function body the error is swallowed by `_trial_eval_fn_body`, so the
whole statement emits `// Failed to transpile` and — because the body eval aborts
there — the enclosing batch `__yo_user_main` goes hollow.

## Affected tests

- `tests/spec/contracts_phase0.test.yo` — arms 2, 18 (`echo(generic(i32), i32(7))`,
  `full(generic(i32), i32(9))`) and line 158 (`f(generic(i32), i32(1))`).
  NOTE: these arms were previously mis-attributed to the `requires`/`ensures`
  contract port. They fail identically with NO contract clause — the trigger is
  the explicit `generic(...)` argument alone.
- `tests/higher_kinded_types.test.yo` — `identity(generic(Option, i32), x)` (:15,
  :291) and the METHOD-call form `container.map(generic(B), f)` (:91).

`tests/codegen-bootstrap/generic_identity.yo` uses `generic(...)` only in the
SIGNATURE, which is why the corpus never caught this.

## Root cause

`BK_GENERIC` (`yo-self/expr.yo:233`) is referenced ONLY in
`yo-self/evaluator/types/function.yo`, `builtins/derive.yo` and `values/impl.yo`
— never in the CALL paths. yo-self therefore counts `generic(i32)` as a regular
argument and the arity check at `yo-self/evaluator/calls/function.yo:3413`
(inline FuncVal arm) rejects the call. `helper.yo:3721` has the same check.

TS peels it before the arity check (`src/evaluator/calls/helper.ts:920-957`):

```ts
let regularArgStartIndex = 0;
if (
  argExprs.length > 0 &&
  exprIsFunctionCallOf(argExprs[0]!, BuiltinKeywords.generic)
) {
  forallArgsExpr = argExprs[0]! as FnCallExpr;
  regularArgStartIndex = 1;
} else if (
  isMethodCall &&
  argExprs.length > 1 &&
  exprIsFunctionCallOf(argExprs[1]!, BuiltinKeywords.generic)
) {
  // self stays at index 0; generic(...) is spliced out of the middle
  forallArgsExpr = argExprs[1]! as FnCallExpr;
  argExprs = [argExprs[0]!, ...argExprs.slice(2)];
}
const adjustedArgExprs = argExprs.slice(regularArgStartIndex);
```

and then binds each forall parameter from `forallArgsExpr.args[i]`
(helper.ts:1070) instead of inferring it, skipping the inference path entirely
when explicit type args were supplied (helper.ts:1470, :1499).

## Port plan

1. Peel `generic(...)` from the argument list in BOTH yo-self call paths
   (`function.yo`'s inline FuncVal arm and `helper.yo`'s
   `try_to_call_function_with_arguments`), including the method-call variant
   where `self` occupies index 0.
2. Run the arity check against the peeled list.
3. Bind forall parameter `i` from the peeled `generic(...)` argument `i`
   (evaluated as a TYPE) instead of inferring it from an argument type; keep the
   inference path for the no-explicit-args case.
4. Populate `ArgValues.forall_args` from those values so the downstream
   specialization keys and substitutions see them.
