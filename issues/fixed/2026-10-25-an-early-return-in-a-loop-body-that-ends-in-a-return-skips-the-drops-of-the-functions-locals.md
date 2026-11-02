# An early `return` in a loop body that ends in a `return` skips the drops of the function's locals

**Severity:** S1 — a leak per call: a function whose `while(true, …)` body
ends in a `return` leaks every owned local at any other `return` in that body,
so a function called repeatedly leaks without bound.

**Status:** fixed (evaluator). Found 2026-10-25 while probing
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

## Root cause

The suspected cause, `evaluate_while`'s return/break flags, was the wrong
site. A runtime `while(true, …)` (no `comptime` modifier) never takes the
flag-propagating branch. Its result is a `unit` built from the loop's own
`env`, and that `env` is what was wrong.

`_evaluate_begin_expression_impl` (`src/evaluator/exprs/begin.yo`) binds
`(env : Environment) = env_in`. `Environment` is a `ref`, so this is the
caller's env object. The block pushes its frame onto that object and pops it
at its end (`pop_frame_nonmutating`). A `return(…)` or `unwind(…)` statement
instead REBOUND `env` to a fresh snapshot of the argument's recorded env
(`env = snapshot_env(&ri.env)`). The pop then ran on the snapshot, and the
caller's object kept the block's frame. A loop body whose last statement is a
`return` therefore left its frame on the loop's env. The `while` recorded its
result in that env, and the function block adopted it. Its epilogue took the
loop body's frame for its own (`current_frame_opt` = the top frame) and handed
its real frame, the one holding `f`, to the parameters pass, whose
`params_only` gate skips every non-parameter. `f` got no scope-end drop, so no
exit released it: not the early `return`, not the final one, not the
unreachable tail. A probe of `_scope_end_drop_eligible` showed it. The loop
body's locals were judged twice, and `f` was judged once, under `params_only`.

A `break` as the last statement does not rebind, so the pop reached the
caller's object and the leak did not happen. A `cond`/`match` arm restores its
own env, which is why a body without the loop dropped `f`. The variant with a
conditional `break` and the one moving `f` before the final `return` leaked
through the same frame.

## Fix

The return and unwind branches adopt the argument's frame LIST into the
block's own env object (`env_adopt(&env, &ri.env)`, the statement-threading
primitive) instead of rebinding `env`. The list is shared copy-on-write, so
the reason the rebinding was written still holds
(`issues/fixed/2026-10-15-return-of-a-function-local-comptime-constant-emits-an-undeclared-c-identifier.md`):
the pop reassigns `frames` on this object and never touches the argument's
recorded scope. The object stays the caller's, so the pop removes the frame
the block pushed.

## Test

`tests/loop_body_return_drops.test.yo` has three cases: the reproducer, the
variant that moves the local before the final `return`, and the variant with a
conditional `break`. Each counts `Drop` calls on every exit, so a leak and a
double drop both fail. All three fail before the fix (`drops 0`) and pass after
it.
