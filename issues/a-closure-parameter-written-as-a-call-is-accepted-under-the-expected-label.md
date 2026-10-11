# A closure parameter written as a call is accepted under the expected label

**Severity:** S3 — an unannotated closure parameter spelled as any one-argument call (`foo(n) => …`) is accepted silently and bound under the expected `Fn` type's label, so a typo or a deleted spelling gets no diagnostic, or a misleading "Variable not found" one.

Found 2026-10-10 while deleting the mode-word spelling (plans/VALUES_BY_DEFAULT.md decision 42 Generation B).

## Reproducer

```yo
{ println } :: import("std/fmt");
apply :: (fn(f : Impl(Fn(n : &mut i32) -> unit), v : &mut i32) -> unit)(f(v));
main :: (fn() -> unit)({
  (x : i32) = i32(1);
  apply(foo(n) => {
    n = (n + i32(1));
  }, &mut x);
  println(x);
});
export(main);
```

`yo check` passes and the program prints `2`. With `foo(m) => { m = … }` the
error is `Variable "m" not found`, pointing at the body instead of the
parameter.

## Root cause

`_get_param_name_from_expr` (`src/evaluator/values/anonymous_function.yo`)
returns the expected label for any parameter expression that is a call other
than `name : T`, so the closure is bound with the slot's label and the written
head is ignored.

## Status

The deleted mode words (`mut(n) => …`, `imm(n) => …`, `inout(n) => …`) are
rejected with E0009 before the name is derived (decision 42 Generation B,
`tests/parameter_modes.test.yo`). Any other call head still falls back to the
expected label. The fix is to reject a call-shaped parameter that is not one of
the wrappers a closure parameter may carry, naming the accepted shapes
(`n`, `n : T`, `n : &mut T`).
