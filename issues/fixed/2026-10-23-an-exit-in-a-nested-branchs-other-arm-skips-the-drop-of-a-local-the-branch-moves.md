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

`_keep_undone_move` (`src/evaluator/utils.yo`) finds the outermost `cond` or
`match` inside the outer arm with an arm BODY holding the move
(`_outer_branch_holding`; a move in a scrutinee or a condition is on every
path and keeps the old record). The kept move then starts AFTER that branch's
last token: `UndoneMove.after` (`src/env.yo`) makes the interval's start
exclusive. The nested branch's own arms record their own moves, so only the
exits after it in the same outer arm see the outer arm's move.

Tests: `tests/move_only.test.yo`, "a nested branch's move does not cover the
exits in its other arms" (`match` > `cond` in both orders and with a keeping
outer arm; `cond` > `cond` in the first and last arm with `continue`, `break`
and `return`; `match` > `cond`; three levels; `cond` > `match` with one
reaching arm, the shapes the join fix alone broke; a `return` after the
nested match; a move in a nested scrutinee). The test fails on develop
`54e94f11e` and passes with the fix.
