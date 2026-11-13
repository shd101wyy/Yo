# A `&mut` lend of a place that a live closure's `&` capture borrows is accepted

**Severity:** S1. While a closure holding `{ t : &h.*.a }` is live, `reset(&mut h)`, `w := &mut h; w.* = …`, a second
closure's `{ m : &mut h }` entry, a `&mut self` receiver call, `for(&mut xs, …)` and `match(&mut s, …)` all pass
`yo check`; the closure then reads through its capture. With an `Rc` payload that is a heap-use-after-free; with a
plain value the closure silently reads the new value. Pre-existing: v0.2.76 accepts every form too. Only the direct
write `h = …` is rejected (E0910).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A32). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-mut-lend-of-a-place-that-a-live-closures-capture-borrows-is-accepted.yo`
(negative, expects E0910):

```yo
reset :: (fn(x : &mut Rc(S)) -> unit)({
  x.* = Rc.new(S(a : String.from("z")));
});
main :: (fn() -> unit)({
  mut(h) := Rc.new(S(a : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz")));
  (g : Impl(Fn() -> usize)) = ({ t : &h.*.a }() => t.clone().len());
  reset(&mut h);
  println(`OUT: ${g().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-local-mut.yo` (negative, E0910): the lend is a local `w := &mut h; w.* = Rc.new(…)`. Accepted, heap-use-after-free.
- `…-closure.yo` (negative, E0910): the lend is a second closure's entry `{ m : &mut h }`, called before `g`. Accepted,
  heap-use-after-free.
- `…-pos.yo` (positive control): `g` lives in a block that ends before `reset(&mut h)`. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape (a closure with `{ r : &s }`, `{ r : &xs }`, `{ f : &s.a }` or `{ t : &h.*.a }` live) | Verdict | Correct |
| --- | --- | --- |
| `h = Rc.new(…)`, a direct write of the captured root | E0910 | E0910 |
| `reset(&mut h)` / `reset(&mut s)` replacing `s` or writing `s.a` | accepted; UAF (`Rc`) or the closure reads the new value | E0910 |
| `w := &mut h; w.* = …` / `w := &mut s; w.a = …` | accepted; UAF / new value | E0910 |
| a second closure `{ m : &mut h }` or `{ m : &mut xs }` called before the first | accepted; UAF / `OUT: 0` | E0910 |
| `xs.clear()` (a `&mut self` receiver), `grow(&mut xs)`, `for(&mut xs, e => …)` | accepted (ledger) | E0910 |
| `match(&mut s, .Some(v) => { v.* = … })` | accepted (ledger) | E0910 |
| `{ y }` copying `y := &h.*.a`, then `reset(&mut h)` (tip only: v0.2.76 rejects `{ y }` with E0926) | accepted (ledger) | E0910 |

## Root cause

A capture-list borrow is recorded in its own registry, `g_capture_freezes` (filled by `note_second_class_binding`
in `src/evaluator/utils.yo`), and that registry is consulted only by `check_capture_freeze_access`
(`src/evaluator/utils.yo`). It raises for an `&` capture only when its caller passes `is_write = true`. The callers
are:

- `evaluate_identifier_and_operator` (`src/evaluator/exprs/identifer_and_operator.yo`), passing `ctx.is_lhs_of_assignment`, which
  only `evaluate_assignment` sets;
- `evaluate_assignment` and `_check_capture_borrow_write` (`src/evaluator/exprs/assignment.yo`): assignments;
- `set_expr_as_consumed` (`src/evaluator/utils.yo`): moves;
- `_require_exclusive_fnmut_callee` (`src/evaluator/calls/function.yo`): calling an `FnMut` closure.

No `&mut` lend reaches it as a write. `&mut h`, a `&mut self` receiver, a `for`/`match` scrutinee and a capture-list
`&mut` entry all evaluate `h` as an identifier outside an assignment, so the check sees a read, which an `&` capture
allows. The local-borrow machinery that does judge `&mut` lends (`local_borrow_access`, `d3_check_pending`) does not
hold capture borrows as loans, and `require_capture_borrow_exclusivity` compares only the arguments of one call (decision 28),
not a closure that lives outside it. (The ledger also names `function.yo`'s call site as "the sink move": it is the
`FnMut` callee check; the move site is `set_expr_as_consumed`.)

## Expected

E0910 at every `&mut` lend of the captured place, a place inside it or a place containing it, while the closure is
live. `REFERENCES_AND_ORIGINS.md` O3 step 2: "a `&(T, p)` conflicts with a write, move, drop or `&mut` borrow by
name of one"; `BORROW_CHECKER_COMPLETENESS.md` §4: "every later write/move/drop/`&mut`-lend of it calls `access`".
A capture is R-LEND of its place (R-CLOSURE-LIT), so the closure's loan is an ordinary `&` loan. The fix passes the
lend's mode into the freeze check (or, per G-A, routes capture borrows through `access`).

## Test

With the fix: the three negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`closure-ref-capture-then-mut-lend` (E0910) and `closure-ref-capture-then-mut-receiver` (E0910) in
`tests/origins/corpus.tsv`; `tests/closure_capture_list.test.yo` gains the `reset(&mut h)` and second-closure cases
beside its direct-write E0910 test.

## Fix

The cluster-2 fix (audit §9: "an access reaches the loan table weaker than its mode, or not at all") adds one
helper, `access_place` / `access_variable` / `access_move` (`src/evaluator/utils.yo`): an access of a place in the
mode the operation declares (read, write, move, `&mut` lend) checked against every loan table the checker holds — the
local borrows and flow sets (E0911, `local_borrow_access`) and the closures' capture borrows (E0910,
`capture_freeze_access`, which now takes the access kind and compares the capture's field path with the accessed
place's).

Every `&mut` lend now reaches the capture borrows: a local `w := &mut h` and a `&mut` projection result
(`exprs/initialization_assignment.yo`), a `match(&mut s, …)` scrutinee (`exprs/match.yo`), a `&mut` tuple element
(`values/tuple.yo`) and struct field (`calls/type.yo`) call `access_place(…, Exclusive)`; a capture-list `&mut` entry
calls `access_expr`; a `&mut` argument, a `&mut self` receiver and the by-value `&mut` lend of `for(&mut xs, …)` carry
the conflict in their pending entry (`D3PendingInout.cap_conflict`, `exprs/assignment.yo`), judged at the call whatever
the callee's body does (the declared mode; the local-borrow half of that rule for summarized callees is still
`issues/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.md`).

Tests: `tests/origins/unsound/c2-ref-capture-then-mut-arg.yo`, `-local-mut.yo`, `-mut-capture.yo`, `-mut-receiver.yo`,
`-mut-scrutinee.yo`, `-mut-walk.yo` (E0910), `c2-ref-capture-then-mut-arg-pos.yo`, `-mut-receiver-pos.yo` (accept, ASan
clean); `tests/closure_capture_list.test.yo` "a `&mut` lend of a place a live closure's `&` capture borrows is E0910".
