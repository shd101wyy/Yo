# A direct projection method call bound to a local reaches the C compiler

**Severity:** S2 — `r := xs.index(i)` on an `ArrayList` passes `yo check`, then fails in clang with an int-from-pointer error, instead of the documented "calling one directly is not supported yet" diagnostic.

**Found:** 2026-10-14, by #1339's Tier 1 while it reproduced the `index_unchecked` gate (fixed by the `fix/develop-index-unchecked-raw-pointer` branch).

## Reproducer

A compiler built from develop at 4d942f533, with that tree's std:

```yo
{ assert } :: import("std/assert");
{ ArrayList } :: import("std/collections/array_list");

main :: (fn() -> unit)({
  xs := ArrayList(i32).new();
  xs.push(i32(7));
  r := xs.index(usize(0));
  assert((r + i32(0)) == i32(7), "r");
});

export(main);
```

```text
a.out.c:2204:11: error: incompatible pointer to integer conversion initializing 'int32_t' (aka 'int') with an expression of type 'int32_t *' (aka 'int *'); dereference with * [-Wint-conversion]
yo: error: compile: C compiler failed (exit 1) on a.out.c
```

## What should happen

Decision 24's first cut rejects a projection (a function returning `&T` / `&mut T`) at any call site other than the subscript its trait dispatches. The guard is in `evaluate_function_call` (`src/evaluator/calls/function.yo`, the `result_is_ref` match after `_consume_fnonce_callee`). Its message says to write `x(i)`. This call site never reaches that error. The evaluator types `r` as the element type, and codegen initializes it with the pointer the projection returns.

## Root cause

Not yet pinned. The guard reads `result_is_ref` from the callee's `ExprInfo` type. For the method form `xs.index(…)` on a generic collection, that type evidently does not carry the flag at this point (the call resolves through the trait method on `ArrayList(i32)`). A direct call by name, as in the decision 24 tests, is rejected.

## Fix direction

V2b's direct projection calls (#1368, Generation A) replace the guard with real support: `r := t.index(i)` becomes a local borrow declared `T* r`. Whichever lands first, the reproducer above becomes a regression test in `tests/index.test.yo`:
- if the guard is fixed first, the test expects the decision 24 diagnostic;
- if #1368 lands first, the binding reads 7.
