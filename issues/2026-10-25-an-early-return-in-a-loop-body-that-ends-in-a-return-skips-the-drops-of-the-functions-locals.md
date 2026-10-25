# An early `return` in a loop body that ends in a `return` skips the drops of the function's locals

**Severity:** S1 — a leak per call: a function whose `while(true, …)` body
ends in a `return` leaks every owned local at any other `return` in that body,
so a function called repeatedly leaks without bound.

**Status:** open. Found 2026-10-25 while probing
`fix/s1-return-before-break-move`. Present on the seed v0.2.69, on develop
`82671f612` and on that branch alike; it does not depend on a move.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");
(mut(g_d) : i32) = i32(0);
Fd :: struct(n : i32, s : String);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
leaks :: (fn(k : i32) -> i32)({
  f := Fd(n : k, s : String.from("a heap string that leaks"));
  while(true, {
    if(k >= i32(5), {
      return(i32(-2));
    });
    return(f.n);
  });
  i32(0)
});
main :: (fn() -> unit)({
  r := leaks(i32(7));
  d := g_d;
  println(`r=${r} drops=${d} (want 1)`);
});
export(main);
```

`yo compile repro.yo --optimize 2 --sanitize address --allocator system`
prints `r=-2 drops=0` and LeakSanitizer reports the `String`. The same body
without the loop drops `f`, and so does the loop when its last statement is a
`break` instead of a `return`. A body that moves `f` before the final
`return` (`take(f); return(…)`) leaks the same way at the earlier `return`,
and so does a body with a conditional `break` before the final `return`.

## Root cause (suspected, not confirmed)

`evaluate_while` (`src/evaluator/exprs/while.yo`, the "return / unwind"
case) gives a `while(true, …)` whose body's control flow includes `Return` the
flags `return` with `break` cleared: the loop is treated as one that always
returns, even when a `break` can leave it. The function block then sees a
statement that diverges on every path, and its early-return drop attachment
for the locals declared before the loop does not reach the `return`s inside
the body. Not confirmed: the codegen side of the early-return drop list was
not traced.

## Test

Goes in with the fix: the reproducer above, plus the variants with a move
before the final `return` and with a conditional `break`.
