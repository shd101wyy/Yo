# A move in a `while` condition escapes the loop move rules

**Severity:** S1. `while(take(a), { … })` passes `yo check` although the condition moves the outer local `a` and
runs once per iteration: the second test passes the freed `a` again (ASan: double free). The same move in the loop
BODY is E0901. Pre-existing: v0.2.76 accepts every form below.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A37). Confirmed on develop `64f33c710`.

## Reproducers

`tests/origins/unsound/while-cond-moves-local.yo` (was `issues/repros/2026-11-11-…`; negative, expects E0901):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
take :: (fn(s : String) -> bool)(s.len() > usize(0));
main :: (fn() -> unit)({
  a := String.from("payload-0123456789abcdefghijklmnop");
  mut(i) := i32(0);
  while(take(a), {
    i = (i + i32(1));
    if(i == i32(2), {
      break;
    });
  });
  println(`OUT i=${i.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: attempting double-free
```

- `while-cond-moves-local-block.yo` (negative, E0901): a block condition `{ t := a; !(take_empty(t)) && (i < i32(2)) }` moves `a` into a
  condition-local on every test.
- `while-cond-moves-local-pos.yo` (positive control): the condition reads `a.len()`; `a` is moved once, after the loop.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `while(take(a), …)` | accepted, double free | E0901 |
| a block condition binding `t := a` (`while-cond-moves-local-block.yo`; ledger g14 tests it once only and runs clean) | accepted, double free | E0901 |
| `while(take_b(a) && (i < i32(3)), …)` on a `Drop` type (ledger c06) | accepted, double free | E0901 |
| `take(a)` in the loop body (ledger c01) | E0901 "moved inside the loop" | E0901 |
| a move in the body on a path that `break`s while the normal exit keeps the value (ledger c02) | E0907 | E0907 |

## Root cause

Verified in `src/evaluator/exprs/while.yo`, `evaluate_while`'s runtime path. The condition is evaluated first
(`evaluated_cond_expr := evaluate_begin_expression(&inner_cond_expr, …)`); only afterwards is the `LoopBodyCtx`
built, with `log_start : branch_init_log_len()`, and set as `ctx.is_evaluating_loop_body` for the body. The loop
rules in `check_loop_flow` (`src/evaluator/utils.yo`) judge exactly the variables `first_flow_records_in(lc.log_start,
…)` returns, so the condition's move record, made before `log_start`, is never judged: neither the back-edge rule
(E0901, "the next iteration uses it again") nor the ways-out rule (E0907). Codegen re-emits the condition at the
top of every iteration, so the one evaluated move becomes one move per test.

## Expected

E0901 at the condition's move. `check_loop_flow`'s first rule (`plans/backlog/TYPE_SYSTEM_SOUNDNESS.md` Phase 5.1,
`issues/fixed/moving-a-variable-inside-a-loop-body-is-not-rejected.md`): "Every way back to the condition … must
leave a value that was live at loop entry live: the next iteration reads it (E0901)." The condition is the first
thing every iteration runs, so a move in it reaches the next test on every back edge. The direct fix takes `log_start`
before the condition is evaluated, so the condition's moves are judged as the body's are.

## Test

With the fix, the two negative programs and the positive control move to `tests/origins/unsound/`;
`tests/move_only.test.yo` gains "move-only: a move in a `while` condition is E0901" next to its loop-body rows.

## Fix

The direct fix from the Expected section, plus the normal exit's state (lane c8e). `evaluate_while`
(`src/evaluator/exprs/while.yo`) takes `branch_init_log_len()` and the frame count before it evaluates the condition, and
builds the `LoopBodyCtx` from them. `check_loop_flow` (`src/evaluator/utils.yo`) therefore judges the condition's
records with the body's. A condition move whose value no back edge gives back is E0901 at the move: "`a` is moved
inside the loop, and the next iteration uses it again".

Taking `log_start` earlier was not enough on its own. The normal way out (the condition turning false) read the state
at loop entry (`pre`), but after a condition move the value is moved there. `while(take(a), { a = fresh(); })` is
sound: each test moves what the iteration before left. With `pre` it would have been joined as live after the loop
and dropped again. `evaluate_while` now snapshots the state the condition leaves (`snapshot_loop_flow`, as a `break`
does), and `check_loop_flow` takes it as `cond_exit`. A variable the condition touched leaves by the normal exit in
the condition's state. A variable it did not touch keeps the old reasoning.

Tests:

- `tests/origins/unsound/` (G-B): `while-cond-moves-local` and `while-cond-moves-local-block` (E0901), and
  `while-cond-moves-local-pos` (accepted, clean under ASan).
- `tests/move_only.test.yo`, "move-only: a move in a `while` condition is E0901" (a call condition and a block
  condition), and "move-only: a `while` condition may move a value the body gives back". The second is the
  `cond_exit` case: six values and a `break` variant, each value disposed exactly once.
