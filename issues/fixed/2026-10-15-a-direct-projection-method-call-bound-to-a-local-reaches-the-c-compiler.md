# A direct projection method call bound to a local reaches the C compiler

**Severity:** S2 — `r := xs.index(i)` on an `ArrayList` passes `yo check`, then fails in clang with an int-from-pointer error, instead of the documented "calling one directly is not supported yet" diagnostic.

**Status:** FIXED 2026-10-15 by V2b's direct projection calls (#1368): `r := xs.index(i)` binds a local borrow declared `T* r`, and a generic impl's projection method is recognized at every position. Regression tests: "V2b: a std collection's index method call binds a local borrow" and "V2b: a generic impl's projection method call is a place" in `tests/index.test.yo`.

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

A method of a generic impl (`ArrayList(T)`'s `index`, or any user
`impl(generic(T : Type), C(T), m : ...)`) is not resolved by the property
access: the receiver-method dispatch in `_evaluate_function_call_unanchored`
(`src/evaluator/calls/function.yo`, the `method_info` arm) finds it, and
leaves the call's `.` callee node without a function type. It records the
method's type under the CALL's id instead (`record_method_callee_type`), and
codegen emits the call through `lookup_method_callee_value`. Both the decision
24 guard and #1368's first recognition (`projection_call_mode_of`,
`call_projection_mode`) read the callee node's type, so neither saw a
projection: the evaluator typed the call as a `T` temporary and the
method-dispatch emitter initialized it with the `T*` the projection returns.
A non-generic type's method (the `Trio` tests) has a typed callee node, which
is why the decision 24 tests passed. The same gap let a write through a READ
projection of a generic impl (`p.at(i) = v`, `-> &T`) pass `yo check`.

## Fix

Recognition falls back to the method type recorded under the call's id when
the callee node has no function type (`projection_call_callee_type`,
`src/evaluator/utils.yo`, and its codegen twin in `call_projection_mode`,
`src/codegen/exprs/_expr.yo`), and the method-dispatch emitter
(`src/codegen/exprs/other_fn_call.yo`) yields the place `(*m(args))` as the
direct-call path does. The original fix direction stated: once #1368 lands,
the reproducer binding reads 7; it is now a test in `tests/index.test.yo`,
with the write-through-a-read-projection rejection for the std and the
generic-impl forms.
