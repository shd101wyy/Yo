# An exit in a nested later arm skips the drop of the moved local

**Severity:** S1 — an unbounded leak, one value per call: a `return` in a later arm of a `cond`/`match` that sits inside an arm of an outer `cond`/`match` never drops a local that an earlier arm of the INNER branch moves, though the move is not on the return's path. Under the B8 flip (`ArrayList`, and so `String`, a value type) this is a `String` leak in `std/encoding/toml.yo`, so it blocks B8.

**Status:** fixed by #1581 (`7b8b04d86`, 2026-10-24), which landed the same day this doc was filed; regression test added 2026-11-02. Found 2026-10-24 by the review of VBD P3 (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.4) against the develop tree binary `f271ed005` and the v0.2.68 seed, both of which predate #1581. It is the nested case that `issues/fixed/2026-10-23-an-exit-in-a-later-arm-than-the-move-skips-the-drop-of-the-moved-local.md` (#1557) left: the one-level shape already dropped the local correctly.

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

`yo compile <repro> -o r && ./r` printed `returned -1, drops 0 (expected 1)` with the v0.2.68 seed and with the tree binary of the day (both before #1581); it prints `drops 1` now. Without the outer `cond` (the inner one alone in the body) it prints `drops 1`.

In the emitted C, the outer `a` arm gets the compensating drop of `d` and the inner `b` arm moves it, but the inner `else` arm's `return` drops only the other locals: `// Drop local variables before early return` does not list `d`.

The same shape, with a `String` local, is `_parse_header`'s `child_path` (and `steps`) in `std/encoding/toml.yo`. Today that `String` is a shared handle and the leak does not show. With the B8 probe's flipped std (`probe/v2b-b8-flip-census`, `9f79e0d4d`), `toml.test.yo` fails two tests on "Memory leak detected": the inputs `[a]\n[a]` (3 bytes) and `[a]\nb.c = 1\n[a.b]` (135 bytes).

## Root cause

The doc's first suspicion (the outer join rewrites `consumed_at_token`, or records the move as an `arm_drop`) was wrong. The outer join does set `consumed_at_token` to the outer branch's end token, but that is harmless: the return lies before it, so `_m3_attach_to_returns` orders the return before the move. The skip came from the predicate both cleanup-drop deciders ask, `variable_moved_at_cleanup_point` (`src/env.yo`).

After the LAST arm of a `cond`/`match`, `keep_last_arm_moves` (`src/evaluator/utils.yo`) keeps that arm's moves as `UndoneMove` intervals through `_keep_undone_move`. Before #1581, `_keep_undone_move` recorded one interval, from the variable's joined `consumed_at_token` to the end of the outer arm. In the reproducer the outer arm's last arm holds the inner `cond`, so the interval ran from `take(d)` in the inner first arm to the end of the outer arm. The inner second arm's `return(i32(-1))` lies inside that interval, though it never made the move. So `variable_moved_at_cleanup_point(d, <return>, true)` answered "already moved here": the evaluator's exit-drop pass attached nothing, and codegen's pending-drop check (the same predicate) emitted nothing either.

This is the defect `issues/fixed/2026-10-23-an-exit-in-a-nested-branchs-other-arm-skips-the-drop-of-a-local-the-branch-moves.md` describes in a loop body (`continue`/`break`/`return` in the nested branch's other arm). The reproducer here is the same interval met in a function body, through the last arm's `keep_last_arm_moves` rather than a sibling arm's `reset_sibling_flow_state`.

## Fix

#1581 made `_keep_undone_move` walk down from the outer arm through each nested branch whose arm body holds the move (`_outer_branch_holding`, `_arm_body_holding`). It now records one interval per level: from the move to the end of the innermost arm body that holds it, then, for each enclosing nested branch, from just after that branch's end (`UndoneMove.after`) to the end of the arm body that holds it. A sibling arm of a nested branch is never covered, so the inner `return` owns `d` again, and the early-return pass drops it there.

No compiler change was needed on 2026-11-02. The original fix plan targeted `_m3_consumed_for_arm` (`src/evaluator/exprs/begin.yo`), which was the wrong site; that function is unchanged.

## Verification (2026-11-02)

- **Bracketing over releases.** The reproducer prints `drops 0` with the v0.2.67 and v0.2.69 binaries and `drops 1` with v0.2.70, the v0.2.73 seed and a develop tree binary (`dc24349c5`'s compiler). A 25-variant probe got 17/25 right on v0.2.69 and 25/25 on v0.2.70 and later. The probe covers cond>cond, match>cond, cond>match, three levels, `break`/`continue` in a loop, both arm orders, and every path of each. #1581 is the only flow-log change between v0.2.69 and v0.2.70.
- **Mechanism.** I built `dc24349c5` with `_keep_undone_move` put back to the single interval (`walking` starts `false`, a scratch build). It gives the reproducer `drops 0` and fails the same 8 of the 25 probe variants that v0.2.69 fails. Under it, `tests/move_only.test.yo` fails the new test and #1581's "a nested branch's move does not cover the exits in its other arms" (87/89). With B8's flipped std, `tests/encoding/toml.test.yo` fails exactly the two tests this doc reported, on "Memory leak detected": "Rejected or parsed correctly: the twelve corruption rows" and "Other rejections carry the right offset" (35/37).
- **Regression test.** `tests/move_only.test.yo`, "move-only: an exit in a nested later arm than the move drops the local once", has three shapes: the doc's cond>cond; match>cond, the `_parse_header` shape whose other outer arms move the local or return; and cond>match. It checks every path with the result, the disposal count and the disposed `n` sum, so a double drop fails it too. Extracted to a standalone program, its four inner-return paths fail under v0.2.69 and all 11 paths pass on develop. The program is also clean under `--sanitize address --allocator system` and under `--allocator debug` (`live at exit: 0 blocks`).
- **B8.** `tests/encoding/toml.test.yo` against B8's flipped std (`vbd/b8-arraylist-string-flip-r4`, `732ddae71`) with the develop tree binary passes 37/37 under ASan with the leak verdict on. A deliberate-leak vacuity probe fails "Memory leak detected" in the same configuration. B8's own compiler changes are API adaptations to the flipped std (`src/codegen` is untouched), so this is the compiler B8 ships. This doc no longer blocks B8.
