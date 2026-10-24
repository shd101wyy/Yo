# An exit in a nested branch's other arm skips the drop of a local the branch moves

**Severity:** S1 — a leak of the local on every loop iteration (or call) that
takes the exit.

**Status:** fixed (branch `fix/s1-match-break-arm-double-drop`). Found
2026-10-23 while fixing
`issues/fixed/2026-10-23-a-match-whose-other-arm-breaks-drops-the-moved-local-again-after-the-match.md`;
that issue's `Option` reproducer hits both defects.

## Reproducer

```yo
{ println } :: import("std/fmt");
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
run :: (fn(k : i32) -> i32)({
  (mut(i) : i32) = i32(0);
  (mut(total) : i32) = i32(0);
  while(i < i32(3), {
    i = (i + i32(1));
    f := Fd(n : i);
    cond(
      (i < i32(100)) => cond(
        (i != k) => {
          total = (total + take(f));
        },
        true => {
          continue;
        }
      ),
      true => {
        total = (total + i32(100));
      }
    );
  });
  total
});
main :: (fn() -> unit)({
  r := run(i32(2));
  d := g_d;
  println(`${r} drops=${d} (want 4 drops=3)`);
});
export(main);
```

Develop `a368eaae0` prints `4 drops=2`: the `continue` at `i == 2` does not
drop `f`. The same holds with `break` or `return` in place of `continue`, with
the nested branch in the outer branch's first or last arm, at three levels
(`cond` > `cond` > `match`), and under a `match` outer branch.

## Root cause

When the next outer arm starts, `reset_sibling_flow_state` undoes the outer
arm's moves and keeps each as an `UndoneMove(moved_at, until)`, a source
interval that codegen's loop-exit drop check and the evaluator's exit-drop
pass (`variable_moved_at_cleanup_point`, `src/env.yo`) read as "moved at any
cleanup point inside". For a move made inside a nested `cond`/`match`,
`moved_at` is the joined `consumed_at_token`: the reaching nested arm's own
move token, or the nested branch's end token (the trailing `continue` itself).
Either way the interval covers the exits in the nested branch's OTHER arms,
which never made the move, so they emit no drop.

## Fix

`_keep_undone_move` (`src/evaluator/utils.yo`) walks down from the outer arm
through each nested `cond`/`match` with an arm BODY holding the move
(`_outer_branch_holding`, `_arm_body_holding`; a move in a scrutinee or a
condition is on every path and keeps the old record). It keeps the move as
one interval per level: from the move to the end of the innermost arm body
holding it, then, for each enclosing nested branch, from just after that
branch's last token to the end of the arm body holding the branch.
`UndoneMove.after` (`src/env.yo`) makes those later intervals' start
exclusive. No interval covers a nested branch's other arms.

The first version of this fix kept only the outermost interval, after the
outermost nested branch, and relied on the nested branch's own arms to record
the move inside it. A nested `cond` folded at compile time (the taken
condition comptime-true, every earlier one comptime-false, `cond.yo`'s
`done_eval`) forms no branch group and records nothing, so an exit after the
move inside it dropped the local a second time (ASan heap-use-after-free;
found in review, 2026-10-24). The per-level record does not depend on the
nested branch recording anything.

Tests: `tests/move_only.test.yo`, "a nested branch's move does not cover the
exits in its other arms" (`match` > `cond` in both orders and with a keeping
outer arm; `cond` > `cond` in the first and last arm with `continue`, `break`
and `return`; `match` > `cond`; three levels; `cond` > `match` with one
reaching arm, the shapes the join fix alone broke; a `return` after the
nested match; a move in a nested scrutinee). The test fails on develop
`54e94f11e` and passes with the fix.

The folded-`cond` shapes (a `return`, a `continue` in a loop, a later clause
taken at compile time, an effect escape through a `sink` callee) are in
"a move in a compile-time-folded nested cond is dropped once at a later
exit".
