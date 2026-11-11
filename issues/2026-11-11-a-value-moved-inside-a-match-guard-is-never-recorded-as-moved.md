# A value moved inside a match guard is never recorded as moved

**Severity:** S1. `r := match(i32(3), (n && (take(a))) => i32(1), _ => i32(2));` passes `yo check` although the
guard moves the outer local `a` into `take`: after the match `a` still counts as live, so the scope end drops it
again (ASan: double free). When the guard fails and a later arm reads `a`, that read is a heap-use-after-free.
Pre-existing: v0.2.76 accepts every form below.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A36). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-value-moved-inside-a-match-guard-is-never-recorded-as-moved.yo` (negative, expects
E0901):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
take :: (fn(s : String) -> bool)(s.len() > usize(0));
main :: (fn() -> unit)({
  a := String.from("payload-0123456789abcdefghijklmnop");
  r := match(i32(3), (n && (take(a))) => i32(1), _ => i32(2));
  println(`OUT r=${r.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710 and v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: attempting double-free
```

- `…-next-arm.yo` (negative, E0901): the guard `take_empty(a)` moves `a` and returns false; the fallback arm
  reads `a.len()` and the println reads `a`: heap-use-after-free.
- `…-pos.yo` (positive control): the guard reads `a.len()`, and `a` is moved once after the match.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| a guard passes an outer local to a by-value parameter (`take(a)`) | accepted, double free | E0901 |
| the guard fails and a later arm reads the moved local | accepted, heap-use-after-free | E0901 |
| a by-value PARAMETER moved by a guard (ledger g15) | accepted, double free | E0901 |
| a guard block binding a guard-local, `{ t := a; t.len() > usize(0) }` (ledger g16) | accepted, double free | E0901 |
| the guard move inside a `while` body (ledger g04) | accepted, double free | E0901 |
| the guard move inside an `io.async` body (ledger y01) | accepted, Drop runs twice | E0901 |
| a guard moves `a` and a later arm's BODY moves it too (ledger g02) | E0907, blamed on the guard's arm | E0901 |
| a guard moves one of its own pattern bindings, `(.Some(t) && (take(t)))` | E0901 | E0901 |

## Root cause

Verified in `src/evaluator/exprs/match.yo`, the arm loop of the match evaluator. A move is recorded in two places:
the shared `Variable` (`consumed_at_token`) and the branch flow log (`record_branch_consume`, via `_log_user_move`),
which `reset_sibling_flow_state` and `merge_and_check_envs` read per arm window. For each arm the loop evaluates the
guard (`evaluate_expression_guarded` / `_evaluate_guard_block`, then `_commit_guard_copies`) BEFORE it calls
`begin_branch_group_arm()`, `reset_sibling_flow_state` and `bir_start_m := branch_init_log_len()`. The guard's move
record therefore falls in the window `begin_branch_group_arm` declares to be "records made by completed sibling
arms", so the `reset_sibling_flow_state` call right after it, for the guard's OWN arm, restores `a` to its
pre-match state before the arm body is evaluated; every later arm does the same, and the record lies outside every
arm's window `[bir_start_m, end)`. The join sees no arm that moved `a`, and after the match `a` is live.
The ledger's guess (`_commit_guard_copies` or the frame
pop losing the state) is not the mechanism: both touch only the arm frame's pattern bindings, and the outer `a`
lives in an enclosing frame.

g02's E0907 comes from the same misplacement: the join compares the arms' bodies only, so it reports "moved in some
arms but not in others" and points at the guard's arm instead of the guard's move.

## Expected

E0901 at the guard's move. A guard runs on a path that can still reach the later arms, so a guard that consumed a
value would hand those arms a moved value. VBD decision 26 already gives that reason for the pattern's own
bindings: "Guards see the bindings as borrows … A guard that consumed a binding would otherwise leave the next arm
a moved payload." A guard may read an outer value or lend it (`peek(&a)`), never move it. (The alternative, a
conditional move joined across the later arms, needs drop flags, which Yo does not have; see E0907.)

## Test

With the fix, the two negative programs and the positive control move to `tests/origins/unsound/`;
`tests/match_guards.test.yo` gains a `comptime_expect_error` row for the
guard move of a local, a by-value parameter and a guard-local, plus the g02 shape, which now reports E0901 at the guard.
