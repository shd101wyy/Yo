# Multi-arg call on a Fn-trait constrained generic param fails

## Symptom

Calling a value bound by a where-clause `where(F <: (Fn(a : A, b : B) -> C))`
with two or more arguments throws:

```
Error: Function call is not implemented yet:
f(acc, item)
```

Single-arg cases (`(pred)(item)`) work — see `Iterator.any` / `Iterator.all`
in `std/prelude.yo`. The 2-arg case in `Iterator.fold` does not.

## Reproducer

```rust
add :: (fn(acc : i32, x : i32) -> i32)((acc + x));
total := my_range(i32(0), i32(5)).fold(i32(0), add);
```

The body of `fold` is `(f)(acc, item)` where `f : F` and `F <: Fn(...)`. The
single-arg dispatch path in `src/evaluator/calls/function.ts` (`isSomeType ||
isDynType`) seems to handle 1-arg fine but the multi-arg case falls through
to the "Function call is not implemented yet" throw at line ~2576.

## Affected code

- `std/prelude.yo` — `Iterator.fold` (line ~6075)
- Any user combinator with a 2-argument Fn callback through a generic param.

## Status: RESOLVED

Fixed by:

1. **Evaluator** (`src/evaluator/calls/function.ts`): pass `env` to
   `extractFnTraitFromType` at lines 1218, 2091, 2094 so where-clause
   constraints stored on `env.whereClauseConstraints` are consulted (not just
   `requiredTraits`). Without `env` these calls returned undefined for
   forall-F-with-where-Fn cases and the dispatch fell through to "Function
   call is not implemented yet". This also fixes the SINGLE-arg case for
   top-level (non-lambda) function values passed through such params.

2. **Codegen** (`src/codegen/exprs/other-fn-call.ts`): when `expr.func` is an
   atom referencing a parameter of `currentFunctionType` whose specialized
   type is a `FunctionType`, emit a direct C call `f(args...)` and use the
   parameter's `return.type` as the result type. Previously the closure-call
   branch always emitted `(f).call((f).data, args...)`, which mismatched the
   function-pointer C parameter declared by `declarations.ts`, and used the
   unspecialized `Acc` callsig return type (rendered as `void*`).

Verified with `tests/iterator_combinators.test.yo` (fold, two-arg combinators
re-enabled) plus `tmp/fn_multiarg*.yo` and `tmp/any_named_fn.yo`.
