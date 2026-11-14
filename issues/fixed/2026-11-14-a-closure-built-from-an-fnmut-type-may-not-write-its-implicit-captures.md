# A closure built from an `FnMut` type may not write its implicit captures

**Severity:** S2 — `mut(c) := Impl(FnMut(y : i32) -> i32)({ x = (x + y); x })` was rejected with E0913 ("an `Fn(...)` closure … whose record holds a copy of `x`") although the closure is typed `FnMut` and owns its record; the same body as an `=>` literal at an `Impl(FnMut(...))` binding is accepted.

Found 2026-11-14 while fixing develop forward after #1932 (audit §9 cluster 2, A46), retyping
`tests/closure.test.yo`'s "Test ClosureType({...}) to create closure value" as `FnMut`.

## Reproducer

```yo
main :: (fn() -> unit)({
  mut(x) := 1;
  ClosureType :: Impl(FnMut(y : i32) -> i32);
  mut(closure) := ClosureType({
    x = (x + y);
    return(x);
  });
  closure(1);
});
export(main);
```

```text
error[E0913]: Cannot assign to `x` here: the closure captures it implicitly, by value, and its call borrows the
captures shared (an `Fn(...)` closure, …)
```

## Root cause

#1932 records which closures may write their implicit captures (`set_closure_writes_captures`) where an `=>`
literal is evaluated (`evaluate_anonymous_function_implementation`, `src/evaluator/values/anonymous_function.yo`).
A closure built by applying its type to a body (`try_to_implement_closure_by_fn_module_type`,
`src/evaluator/calls/closure_type.yo`) is a second construction path that never registered, so every write of an
implicit capture in it was E0913, whatever the type said.

## Fix

`try_to_implement_closure_by_fn_module_type` registers its closure the same way: it may write implicit captures when
its type is `FnMut`/`FnOnce` and it is not lent to a borrowing parameter.

## Test

`tests/closure.test.yo` "Test ClosureType({...}) to create closure value" (typed `FnMut`).
