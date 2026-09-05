# `ensures(...)` asserts are skipped when the body exits through `return(...)`

**Status: OPEN — found 2026-09-05 while auditing `plans/FORMAL_VERIFICATION.md`
(PR #411). Fix is scheduled as Phase V1 task 2b of that plan.**

## Symptom

A function whose `ensures(...)` post-condition is violated on an early-return
path returns the violating value silently. No panic, exit code 0.

```rust
{ println } :: import("std/fmt");
// ensures claims result >= 0, but the early return path yields -5.
f :: (fn(x : i32, ensures(result >= i32(0))) -> i32)({
  if(x < i32(0), { return(i32(-5)); });
  x
});
main :: (fn() -> i32)({
  println(f(i32(-1)));
  i32(0)
});
export(main);
```

```
$ yo compile issues/repros/contracts-ensures-skipped-by-early-return.yo --optimize 2 -o er && ./er
-5
rc=0
```

Expected: a panic `ensures failed: result >= i32(0)` (the same behaviour the
tail path produces — replace the body with `-(x)` and it panics as it should).

Reproducer: `issues/repros/contracts-ensures-skipped-by-early-return.yo`.
Measured with `yo 0.2.24`.

## Root cause

`wrap_function_body_with_contracts` (`src/evaluator/builtins/contracts.yo`)
lowers a function with post-conditions to

```
{ snapshots; requires-asserts; result := (<body>); ensures-asserts; result }
```

`return(e)` inside `<body>` exits the *enclosing function*, so control never
reaches the `ensures-asserts` that follow the binding. The lowering only
guards the tail-expression exit.

## Fix (planned — plans/FORMAL_VERIFICATION.md, Phase V1 task 2b)

The wrapper walks the body and rewrites every `return(e)` that belongs to
this function — stopping at nested fn literals, `ctl` handlers and async
blocks, which have their own `return` — into

```
return({ <label> := e; <ensures-asserts>; <label> })
```

(unit-returning functions: `return({ <ensures-asserts>; })`). `unwind(...)`
paths stay exempt: they never reach the post-condition. `old(...)` snapshots
are hoisted at entry already, so they are visible at every rewritten site.

## Regression tests to add with the fix

- `tests/spec/contracts_phase0.test.yo`: an early-return violation panics
  in `runtime` mode (bugged twin of a passing early-return function).
- A nested fn literal containing its own `return` inside a contract-bearing
  function is left alone (its `return` does not get the outer asserts).
- `-> unit` function with `ensures` and an early `return()`.
