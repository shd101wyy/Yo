# A `return` before a loop's `break` move skips the drop of the local the `break` path moves

**Severity:** S1 — a leak per call: a local declared outside a `while` loop, moved only on a `break` path, is not dropped by a `return` that runs earlier in the loop, so a function called repeatedly leaks without bound.

**Status:** fixed (branch `fix/s1-return-before-break-move`). Found 2026-10-24
in the adversarial review of the match-join fix
(`issues/fixed/2026-10-23-a-match-whose-other-arm-breaks-drops-the-moved-local-again-after-the-match.md`).
It was on develop before that fix too: binaries built from `f271ed005`,
`3b908095f` and `7b8b04d86` give the same count.

## Reproducer

`issues/repros/2026-10-24-a-return-before-a-loops-break-move-skips-the-drop-of-the-local-the-break-path-moves.yo`

```yo ignore
f := mk(k);
while(true, {
  i = (i + i32(1));
  if(i == k, { take(f); break; });
  if(i == i32(2), { return(i32(-2)); });
});
```

With `k = 3` the loop reaches `return(i32(-2))` at `i == 2`, before the
iteration that moves `f`. Expected `made=2 drops=2`; the repro prints
`made=2 drops=0`. The `match` spelling of the branch
(`match(i == k, true => { take(f); break; }, false => ())`) leaks the same way.
Without a loop (`if(c, { return(take(f)); }); if(d, { return(i32(-2)); })`) the
count is right.

## Scope, as measured at the fix

Every exit that can run in the loop body on an iteration that did not take
the moving `break` arm, and lies after that arm in the source, skipped the
drop: a `return` (the body's last statement or not, after a `continue`, in an
inner loop whose `break` moves the value), an effect escape (`unwind` from a
handler) later in the body, a `return` between two moving `break`s, and the
same shapes inside an `io.async` body across an await. An exit before the
moving arm, an exit inside the moving arm after the move, and a branch with
no loop were already correct.

## Root cause

The loop join, not codegen. `check_loop_flow` (`src/evaluator/utils.yo`)
sets the variable's state after the loop to the first `break` snapshot's
token: for `if(i == k, { take(f); break; })` that is the `f` of `take(f)`.
The `if` join had already undone the arm's move for the code after the
branch and kept it as an `UndoneMove` window over the arm only; the loop join
then put it back as the variable's last move, AT the move site. Both
cleanup deciders read `consumed_at_token` as "moved on every path textually
after it": the evaluator's early-return pass (`_attach_if_cleanup_needs_drop`
attaches a drop only when the cleanup point is before `consumed_at_token`,
`src/evaluator/exprs/begin.yo`) and codegen's escape drops
(`_variable_moved_before_cleanup_point`, `src/codegen/exprs/return.yo`). A
`return` after `take(f)` in the source therefore got no drop, and `f`, being
consumed, had no scope-end drop either.

A branch join already avoids this: it marks an arm's move at the branch's
END token (`arm_move_end`) and keeps the move itself as a window. The loop
join never did.

## Fix

The loop join works like the branch join (`src/evaluator/utils.yo`,
`src/evaluator/exprs/begin.yo`, `src/evaluator/exprs/while.yo`):

- A value live when the loop began and moved on every way out of it
  (`pre` is none, no live exit) is marked moved just past the loop's last
  token (`_mark_moved_at_loop_end`). Past it, not at it: a `return` that is
  the body's last statement has the loop's last token as its cleanup point.
  The user's move stays the "value moved here" note of a later E0901
  (`variable_note_arm_move`).
- At each `break`, each move the path made since the loop began, of a value
  declared outside the loop and live at entry, is kept as an `UndoneMove`
  window from the move to the `break` (`keep_break_path_moves`). That keeps
  the exits on the break path itself correct: a straight-line
  `take(f); escape; break;` and a `return` after the move in the moving arm
  still drop nothing.
- Codegen's task-slot move (`_sm_consuming_read`, `src/codegen/exprs/atom.yo`)
  treats a read at a kept window's move site as a move too
  (`_is_kept_move_site`). Without it, a `break`-path move inside an
  `io.async` body would stop setting the slot's move flag once the loop's
  join no longer names the move site. The same check fixes branch-arm moves
  in task bodies, which never set the flag
  (`issues/fixed/2026-10-24-an-aborted-task-drops-a-local-a-branch-arm-moved-a-second-time.md`).

The readers are unchanged: they still consult `consumed_at_token` and
`variable_moved_at_cleanup_point`.

## Test

`tests/move_only.test.yo`: "an exit before a loop's `break` path moves the
local drops it" (the repro's two functions plus the escape, nested-loop, two-
break, `continue` and not-last shapes, and the exits on the break path that
must drop nothing) and "in an io.async loop, a `return` before the `break`
path moves a slot local drops it". Both fail on develop `48b8e93a1` and pass
with the fix. The repro prints `made=2 drops=2`.
