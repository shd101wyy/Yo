# An operator or method on a refined value finds no impl

**Severity:** S2 — valid code is rejected: a value whose type is a refinement
(`refine(i32, p)`, `NonZero(i32)`, …) cannot be the left operand of an operator
or the receiver of a method, so `abs(x) == 3` fails `yo check` when `abs`
returns a refined type.

**Status: FIXED 2026-10-03.** Found while confirming
`issues/fixed/refined-param-signatures-emit-malformed-c.md`.

## Reproducer

```rust
{ assert } :: import("std/assert");
_nonneg :: ghost_fn((fn(v : i32) -> bool)(v >= i32(0)));
_abs :: (fn(x : i32) -> refine(i32, _nonneg))(cond((x >= i32(0)) => x, true => -x));
main :: (fn() -> unit)({
  assert(_abs(i32(-3)) == i32(3), "abs");
});
export(main);
```

```
error[E0610]: No matching call found for operator "==" with receiver type "refine(i32, @51000000)"
```

Measured on a develop build (`300cdb9a3`). The same failure with the result
first bound by `(a : i32) = _abs(i32(-5)); a == i32(5)`. A refined PARAMETER
used as the left operand (`denom * i32(2)` inside the callee) checks fine; a
refined value on the RIGHT (`num / denom`) checks fine.

## Cause

Refinement erasure was applied at binders: every `add_variable_to_env` site
stores `t_refine_inner(ty)` ("so operators, codegen and the verifier's sorts
see the plain T"). A call's result is not a binder, so its ExprInfo keeps the
declared `refine(...)` type, and operator dispatch reads the left operand's
ExprInfo type as the receiver (`src/evaluator/calls/function.yo`, the infix
arm). `get_receiver_methods_by_name_from_env` then looked for methods on a
`RefineT`, which has none.

The verifier tracks refinements on parameters only (`get_func_refined_params`);
a refined result type is never read as a spec, so erasing it at dispatch
cannot change a proof.

## Fix

`get_receiver_methods_by_name_from_env` (`src/env.yo`) erases the receiver with
`t_refine_inner` before any lookup, so operators and methods on a refined value
resolve against its inner type, as at every binder.

Test: `tests/spec/refine_types.test.yo` "a refined result answers its inner
type's operators and methods" (`==`, `+`, a declared-`i32` binder, and
`.to_string()` on a refined result).
