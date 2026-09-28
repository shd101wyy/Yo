# `break()` / `continue()` in an arm's post-await code emits raw C `break;` / `continue;` inside the dispatch `switch`

**Severity:** S1 — post-await `break()`/`continue()` emit raw C keywords in the dispatch switch — breaks silently ignored (wrong control flow), the continue shape fails the C compile

**Status: OPEN.** Found 2026-09-28 by the async state-machine audit's control-flow shape sweep (`plans/ASYNC_STATE_MACHINE_GENERATION.md` §8). Confirmed with a tree build of develop `af62bdb28` and the v0.2.45 seed, with the inner future both suspending and completing synchronously, at `-O0` and `-O2`. `yo check` is green for every shape here. Expected values come from the same program written synchronously.

## Symptom

- `issues/repros/async-shape-b4a-break-after-await-in-arm-ignored.yo` (if arm) and
  `issues/repros/async-shape-b4c-break-after-await-in-match-arm-ignored.yo` (enum match arm):
  expected `100,201,406`, got `5555,5455,4955`. `break;` leaves only the C
  `switch (sm->cond_branch_N)`, so the loop keeps going, and the code after
  the arm runs as well.
- `issues/repros/async-shape-b4b-continue-after-await-in-arm-c-error.yo`: clang reports
  `'continue' statement not in loop statement`.

## Root cause

`_emit_cond_branch_remaining` and `_emit_cond_branch_continuation`
(`src/codegen/async/state_machine.yo`) never install
`context.sm_while_break_info` / `sm_while_continue_info`, so the
break/continue emitter (`src/codegen/exprs/atom.yo`) falls back to the C
keywords. `_emit_outer_while_continuation` does install them.

## Fix

Plan phase 5 (C loops stay real loops, so `break`/`continue` are the
ordinary ones). Regression: all three repros.
