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

## Status: PARTIALLY RESOLVED

**Working:**

- Named-fn arguments: `fold(0, add)` where `add :: (fn(acc:i32, x:i32) -> i32)(...)`.
- Inline named-fn arguments: `fold(0, (fn(acc : i32, x : i32) -> i32)((acc + x)))`.
- Single-arg lambdas: `iter.filter(x => (x.* > i32(0)))`.
- Single-arg lambdas via Fn(\*) trait param.

Fixed by:

1. **Evaluator** (`src/evaluator/calls/function.ts`): pass `env` to
   `extractFnTraitFromType` at lines 1218, 2091, 2094 so where-clause
   constraints stored on `env.whereClauseConstraints` are consulted (not just
   `requiredTraits`). Without `env` these calls returned undefined for
   forall-F-with-where-Fn cases and the dispatch fell through to "Function
   call is not implemented yet".

2. **Codegen** (`src/codegen/exprs/other-fn-call.ts`): when `expr.func` is an
   atom referencing a parameter of `currentFunctionType` whose specialized
   type is a `FunctionType`, emit a direct C call `f(args...)` and use the
   parameter's `return.type` as the result type.

**NOT yet working — multi-arg lambda form:**

```rust
fold(i32(0), (acc, x) => (acc + x))   // FAILS C compile
```

Root cause (codegen): the lambda's `closureFunctionValue.type.parameters[i].type`
is set to the unresolved forall SomeType (`Acc`) from the outer call's Fn
trait constraint. `Acc.resolvedConcreteType` is never populated because
fold's specialization binds `Acc → i32` via the env's comptime variable
binding, not by mutating the SomeType wrapper. As a result:

- `declarations.ts` skips emitting the closure C function (it has SomeType
  params, looks "generic").
- The call site `closure_xxx(&f, acc, item)` references an undeclared
  function → C compile error.

**Workaround:** use `(fn(acc : i32, x : i32) -> i32)(...)` instead of the
`=>` lambda form for multi-arg callbacks until the substitution issue is
fixed at evaluator level (substitute SomeTypes through env when assigning
expected param types to lambda parameters in `anonymous-function.ts`).

Verified-working forms in `tests/iterator_combinators.test.yo`.
