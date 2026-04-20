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

## Workaround

For now, restructure the API to take 1-arg callbacks (e.g., capture `acc` in
a Box passed by reference), or call the function by its concrete name
(non-generic).

## Suggested fix

In `tryToCallFunctionWithArguments` (`src/evaluator/calls/function.ts`), the
SomeType/DynType branch (~line 2088) should handle the multi-arg case the
same way as 1-arg. Investigate whether `extractFnTraitFromType` returns the
correct `callType` when the Fn trait has 2+ params, and whether the arg
binding loop assumes a single arg.
