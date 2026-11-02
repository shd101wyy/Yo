# An exit in a nested later arm skips the drop of the moved local

**Severity:** S1 — an unbounded leak, one value per call: a `return` in a later arm of a `cond`/`match` that sits inside an arm of an outer `cond`/`match` never drops a local that an earlier arm of the INNER branch moves, though the move is not on the return's path. Under the B8 flip (`ArrayList`, and so `String`, a value type) this is a `String` leak in `std/encoding/toml.yo`, so it blocks B8.

**Status:** open. Found 2026-10-24 by the review of VBD P3 (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4). Pre-existing: the v0.2.68 seed and the develop tree binary (`f271ed005`) both leak. It is the nested case that `issues/fixed/2026-10-23-an-exit-in-a-later-arm-than-the-move-skips-the-drop-of-the-moved-local.md` (#1557) left: the one-level shape drops the local correctly.

## Reproducer

`issues/repros/2026-10-24-an-exit-in-a-nested-later-arm-skips-the-drop-of-the-moved-local.yo` (a `Drop` counter):

```yo
f :: (fn(a : bool, b : bool, k : i32) -> i32)({
  d := D(n : k);
  (mut(total) : i32) = i32(0);
  cond(
    a => (),
    true => {
      cond(
        b => {
          total = take(d);
        },
        true => {
          return(i32(-1));
        }
      );
    }
  );
  total
});
```

`yo compile <repro> -o r && ./r` prints `returned -1, drops 0 (expected 1)`, with the seed and with the tree binary. Without the outer `cond` (the inner one alone in the body) it prints `drops 1`.

In the emitted C, the outer `a` arm gets the compensating drop of `d` and the inner `b` arm moves it, but the inner `else` arm's `return` drops only the other locals: `// Drop local variables before early return` does not list `d`.

The same shape, with a `String` local, is `_parse_header`'s `child_path` (and `steps`) in `std/encoding/toml.yo`. Today that `String` is a shared handle and the leak does not show. With the B8 probe's flipped std (`probe/v2b-b8-flip-census`, `9f79e0d4d`), `toml.test.yo` fails two tests on "Memory leak detected": the inputs `[a]\n[a]` (3 bytes) and `[a]\nb.c = 1\n[a.b]` (135 bytes).

## Root cause (suspected, not confirmed)

The exit-drop walk `_m3_attach_to_returns` (`src/evaluator/exprs/begin.yo`) orders each exit against the variable's `consumed_at_token`. On entering arm `i` of a branch, `_m3_consumed_for_arm` clears that token when it lies in the body of an earlier arm of the SAME branch, and only when the flow log kept that move for its arm (`_m3_is_flow_logged_move`: an `UndoneMove` at exactly that token, `arm_drop` false). The one-level case passes both tests. In the nested case the outer branch's join also undoes the move: its `a` arm gets a compensating drop. The suspicion is that this join either rewrites `consumed_at_token` or records the move as an `arm_drop`. Either way the inner walk no longer recognises the move as one that belongs to its earlier arm, so it orders the `return` after the move and attaches no drop.

## Fix plan

Find which of the two the outer join does: print `variable_undone_moves(d)` and `consumed_at_token` at the inner `cond` during the walk. Then make `_m3_consumed_for_arm` recognise a move made in an earlier arm of the inner branch even after an enclosing join. Move the reproducer into `tests/move_only.test.yo` beside "move-only: an exit in a later arm than the move drops the local once" as a nested `cond` and a nested `match` case: it fails before the fix (0 drops) and passes after (1). The gate is the one #1557 used: the dup/drop emit diff of `src/main.yo` with no temp drops added, and its `parse_target` probe under `--sanitize address --allocator system`.
