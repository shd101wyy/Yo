# A move in a `while` condition escapes the loop move rules

**Severity:** S1. `while(take(a), { … })` passes `yo check` although the condition moves the outer local `a` and
runs once per iteration: the second test passes the freed `a` again (ASan: double free). The same move in the loop
BODY is E0901. Pre-existing: v0.2.76 accepts every form below.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A37). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-move-in-a-while-condition-escapes-the-loop-move-rules.yo` (negative, expects E0901):

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

- `…-block.yo` (negative, E0901): a block condition `{ t := a; !(take_empty(t)) && (i < i32(2)) }` moves `a` into a
  condition-local on every test.
- `…-pos.yo` (positive control): the condition reads `a.len()`; `a` is moved once, after the loop.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `while(take(a), …)` | accepted, double free | E0901 |
| a block condition binding `t := a` (ledger g14) | accepted, double free | E0901 |
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
