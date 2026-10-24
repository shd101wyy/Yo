# A known-scrutinee `match` drops a value its selected arm moved a second time

**Severity:** S1 — memory unsafety in generated code: when a `match` on a
compile-time-known scrutinee selects an arm that moves a local, and a later arm
reaches the join without moving it, the scope end drops the moved local again
(a double `Drop`; for a `String`, a heap use-after-free under ASan).

**Status:** fixed 2026-10-24 on `fix/b8bug-returning-arm`, by the same change as
`issues/fixed/2026-10-22-a-move-in-a-returning-match-arm-leaks-into-the-continuation-when-the-scrutinee-is-a-call.md`
(see Fix). **Found:** 2026-10-24 by the review of that branch. Develop
`c45d099b4` has it.

## Reproducer

`issues/repros/2026-10-24-a-known-scrutinee-match-drops-a-value-its-selected-arm-moved-twice.yo`:

```yo
{ println } :: import("std/fmt");
{ assert } :: import("std/assert");
(mut(g_d) : i32) = i32(0);
Fd :: struct(n : i32);
impl(
  Fd,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_d = (g_d + i32(1));
    })
  )
);
take :: (fn(sink(f) : Fd) -> i32)(f.n);
f :: (fn() -> i32)({
  bad := Fd(n : i32(1));
  v := match(i32(4), i32(4) => take(bad), _ => i32(0));
  v
});
g :: (fn() -> i32)({
  bad := Fd(n : i32(1));
  v := match(Option(i32).Some(i32(2)), .Some(x) => (take(bad) + x), _ => i32(0));
  v
});
main :: (fn() -> unit)({
  f();
  g();
  {
    gd := g_d;
    println(&gd);
  };
  assert(g_d == i32(2), "once each");
});
export(main);
```

Compiled with `--optimize 2 --sanitize address --allocator system`, develop
`c45d099b4` prints `4` and the assert fails: `Drop` runs four times for two
values. With `bad` a `String` moved into a `sink(s) : String` parameter
instead, the binary reports `heap-use-after-free` under ASan. The fixed binary
prints `2` and runs clean in both forms.

## Root cause

The join at the end of `evaluate_match` (`src/evaluator/exprs/match.yo`). For a
compile-time-known scrutinee (Cases 1 and 2 of that join) it `env_adopt`s the
selected arm's env, but the move state lives on the shared `Variable` objects,
which keep whatever the arm evaluated LAST left. Here the last arm is the
unselected `_ => i32(0)`: `reset_sibling_flow_state` undid the selected arm's
move before evaluating it, and nothing restored it, so after the `match` `bad`
reads as live and the scope end drops it again. The moving arm's `take(bad)`
already consumed it.

It is the mirror image of the 2026-10-22 bug, where the last arm's move
survived the join (a false E0901); here the selected arm's move is lost.

## Fix

The 2026-10-22 doc's Fix: Cases 1–3 also run the one arm they pick through
`merge_and_check_envs`, which rebuilds every variable touched since the branch
began from the flow log, so the selected arm's move is what the code after the
`match` sees. No separate change was needed.

Regression test: "move-only: a known-scrutinee match drops a value its selected
arm moved exactly once" in `tests/move_only.test.yo`, covering a known integer
and a known enum scrutinee whose selected arm moves, and a known integer whose
selected `_` arm keeps the value. It counts `Drop` runs per call.
