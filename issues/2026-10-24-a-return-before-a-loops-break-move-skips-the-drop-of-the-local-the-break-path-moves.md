# A `return` before a loop's `break` move skips the drop of the local the `break` path moves

**Severity:** S1 — a leak per call: a local declared outside a `while` loop, moved only on a `break` path, is not dropped by a `return` that runs earlier in the loop, so a function called repeatedly leaks without bound.

**Status:** open. Found 2026-10-24 in the adversarial review of the match-join fix
(`issues/fixed/2026-10-23-a-match-whose-other-arm-breaks-drops-the-moved-local-again-after-the-match.md`).
It is on develop, not introduced by that fix: the develop binary built from
`f271ed005` and the fix binary give the same count.

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

## Root cause (suspected, not confirmed)

The only exit that leaves the loop is the `break`, so after the loop `f` is
moved, and its `consumed_at_token` stays the token of `take(f)`. Codegen's
cleanup at the `return` decides "moved on the path here" by source position:
`_variable_was_consumed_before_cleanup_point` (`src/codegen/exprs/return.yo`)
and the `ct.character <= exit_tok.character` test in
`src/codegen/exprs/atom.yo` both read a move that lies earlier in the source as
a move on the path. Inside a loop body that is not so: the `break` arm's move
is on the path of that arm only, and an exit later in the body runs on
iterations where the arm did not run. The kept-move window
(`UndoneMove`, `src/evaluator/utils.yo` `_keep_undone_move`) covers only the
moving arm, so the fallback to `consumed_at_token` is what goes wrong.

## Fix direction

At a cleanup point inside the loop body, a move made in a diverging arm
(`break`/`continue`/`return`) is never on the path to a later exit of the same
iteration. Either do not let the loop join's post-loop `consumed_at_token`
stand for exits inside the loop body (the body's exits run with the state from
before the jump), or record the jump arm's move as a kept window and let the
cleanup points consult only the windows inside a loop.

## Test

The repro above asserts the counts; it fails on develop today. A
`tests/move_only.test.yo` case with the same two functions goes in with the fix.
