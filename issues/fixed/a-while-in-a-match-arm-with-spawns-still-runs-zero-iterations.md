# An `io.spawn` of an inline `io.async` block is DROPPED from a match arm that also has an awaiting `while`

**Found**: 2026-09-14, while fixing
`issues/fixed/a-while-loop-inside-a-match-arm-runs-its-trailing-code-every-iteration.md`.
**Status**: **FIXED 2026-09-14** in `src/codegen/async/state_code_gen.yo` —
`branch_has_await` now stops at a nested `io.async` block, the boundary
`split_body_at_suspension_points` and `contains_suspension_expr` in the same
file already use. Gated by `tests/async_while_in_match_arm.test.yo` (5 tests,
two of them new); both reproducers run correctly (765 and 827 turns, vs
`turns=0`), and the new test FAILS on the v0.2.32 seed and passes here. Full
fast suite 4244 passed / 0 failed.

Root cause, confirmed against the emitted C: `branch_has_await` recursed into
the nested `io.async` closure and found ITS `io2.await`, so the statement that
merely CONSTRUCTS the block to hand to `io.spawn` was mistaken for the branch's
awaiting statement. `generate_cond_branch_with_await` set `found_await` on it,
found no handler (its RHS is a `spawn` call, not an await), emitted NOTHING for
it, and pushed everything after it into `remaining`.

Originally filed as a SECOND defect in the same family, NOT fixed by the
trailing-code change.
**Re-measured 2026-09-14**, and the original characterization below the fold was
WRONG in two ways: two spawns are not required (one is), and the loop is not
what runs zero times — the **spawn never runs at all**.
**Reproducer**: `issues/repros/spawn-of-an-inline-async-block-in-a-match-arm-is-dropped.yo`
(15 lines of body, no network, no timing dependence).

## Symptom

```
A: arm entered
turns=0
BUG: the spawn was dropped, so the loop saw an unassigned handle
```

`B` and `C` never print. The arm is truncated after its FIRST statement.

## The three ingredients, each necessary

Measured one at a time, each as its own compile, on the fixed compiler:

| shape | result |
| --- | --- |
| arm + inline-`io.async` spawn + awaiting `while` | **broken** |
| the same body OUTSIDE any match | works (782 turns) |
| spawn `sleep(...)` instead of an inline `io.async` closure | works (878 turns) |
| drop the `while` (spawn + plain statements after) | works |
| TWO plain `sleep` spawns + awaiting `while` | works (769 turns) |
| TWO spawns where the first is an inline `io.async` closure | broken |

So the trigger is **a match arm + a spawn whose argument is an inline
`io.async` block + an awaiting `while` after it**. The spawn COUNT is
irrelevant — what matters is whether any spawned argument is a nested async
block. The earlier "needs two spawns" reading came from varying two things at
once.

## What the emitted C shows

The arm's `case` in state 0 contains only the branch tag and the payload
binding — the spawn is not there, and `sm->var_h_…` is assigned NOWHERE in the
file:

```c
case __YO_T_840350763561994393_LIMIT: {
  sm->cond_branch_0 = 2;
  sm->var_secs_2185503934883823007 = sm->__capture.o.data.Limit.secs;
  break;
}
```

while the post-await dispatch still reads that never-assigned field:

```c
switch (sm->cond_branch_0) {
  case 2: {
    while (true) {
      bool …146147223485560216812 = …_ret_bool(sm->var_h_8604776450266449399);
      if (!((!(…146147223485560216812)))) { break; }
      …
```

`while_loop_0_active` is declared in the state struct and never assigned or
tested — the async-while wiring was not emitted either. Compare a WORKING
no-spawn arm, which emits the full set (`while_loop_0_start`,
`sm->while_loop_0_active = true`, `while_loop_0_end`, `after_while_loop_0`, and
the resume-side checks).

So this is not "the loop runs zero iterations". The loop is a downstream
victim: its condition reads a handle whose initializing statement was deleted.

## Hypothesis for the root cause — NOT yet confirmed

`_emit_match_case_await_or_value` splits an arm at its await point:
`generate_cond_branch_with_await` emits everything BEFORE the await inline and
returns the rest as `remaining`. A nested `io.async` closure contains its own
`io2.await(...)`, which belongs to the NESTED state machine, not this one — but
it appears EARLIER in source order than the arm's real await (the `yield` in
the loop body). If the await scan does not stop at a nested `io.async`
boundary, the split point lands before the spawn: nothing is emitted inline,
and the spawn falls into `remaining`. The `has_while` path then passes an
EMPTY remaining to `_push_cond_branch` and hands the real `remaining` to
`_attach_cond_branch_post_while` — so a statement that belonged BEFORE the loop
is either relocated after it or dropped.

That would explain every row of the table: the inline `io.async` supplies the
misattributed await, the `while` is what makes the arm take the splitting path
at all, and outside a match no such arm split happens.

**Check this before anything else** by dumping, for both the working and broken
shapes, the await index the arm is keyed under and the index the `while`
registered in `context.async_while_loop_info`, plus whether the await scan
descends into a nested `io.async`. The prior fix in this family was exactly a
mismatch of that kind.

## Why it is filed rather than fixed

The production case it came from — `std/http`'s `_fetch_deadline` — now works
and `tests/http/http.test.yo` is 51/51, so nothing in flight depends on it.
It is real, narrow, and has a standalone reproducer.
