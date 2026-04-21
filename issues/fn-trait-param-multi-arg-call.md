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

**Working (all forms):**

- Named-fn arguments: `fold(0, add)` where `add :: (fn(acc:i32, x:i32) -> i32)(...)`.
- Inline named-fn arguments: `fold(0, (fn(acc : i32, x : i32) -> i32)((acc + x)))`.
- Single-arg `=>` lambdas: `iter.filter(x => (x.* > i32(0)))`.
- **Multi-arg `=>` lambdas: `fold(0, (acc, x) => (acc + x))`** — now fixed.

Fixed in three steps:

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

3. **Evaluator** (`src/evaluator/values/anonymous-function.ts`): when a
   lambda is being type-checked against an `Impl(Fn(...))` expected type,
   the Fn trait's `callType` may still reference unresolved forall SomeTypes
   from a generic where-clause (e.g., `Fn(acc: Acc, item: A) -> Acc` from
   `fold`'s `where(F <: Fn(...))`). The new `substituteSomeTypesFromEnv`
   helper walks the FunctionType (recursing through `Ptr`, `Slice`, `Array`,
   nested `FunctionType`) and substitutes each SomeType with the concrete
   type bound to a same-named comptime variable in the callee's env. This
   ensures lambda parameter bindings, the closure's `closureFunctionValue.type`,
   and downstream codegen all see the concrete runtime types so the closure's
   C function is properly emitted (no longer skipped by the
   `typeContainsSomeType` gate in `declarations.ts`).

Regression tests in `tests/iterator_combinators.test.yo`:

- `iter.fold with multi-arg => lambda`
- `iter.fold over ArrayList iter with multi-arg => lambda`
