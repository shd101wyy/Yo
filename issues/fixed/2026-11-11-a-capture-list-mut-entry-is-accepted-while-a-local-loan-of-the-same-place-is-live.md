# A capture-list `&mut` entry is accepted while a local `&` loan of the same place is live

**Severity:** S1. `r := first(&xs);` followed by a closure literal with the entry `{ m : &mut xs }` passes `yo check`;
the closure grows `xs`, the buffer `r` points into is reallocated, and the later `r.len()` is a heap-use-after-free.
The same holds inside a read walk `for(&xs, e => …)`, a `match(&opt, .Some(v) => …)` arm and a `&mut self` method.
Pre-existing: v0.2.76 accepts it too. The plain argument `grow(&mut xs)` in the same position is E0911.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A33). Confirmed on develop `64f33c710`. The mirror image
(a closure's `&` capture live, then a `&mut` lend) is
`issues/fixed/2026-11-11-a-mut-lend-of-a-place-that-a-live-closures-capture-borrows-is-accepted.md`.

## Reproducers

`issues/repros/2026-11-11-a-capture-list-mut-entry-is-accepted-while-a-local-loan-of-the-same-place-is-live.yo`
(negative, expects E0911):

```yo
first :: (fn(xs : &ArrayList(String)) -> &String)(&xs(usize(0)));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  r := first(&xs);
  (mut(c) : Impl(FnMut() -> unit)) = ({ m : &mut xs }() => {
    mut(i) := i32(0);
    while(i < i32(1000), {
      m.push(String.from("z"));
      i = (i + i32(1));
    });
  });
  c();
  println(`OUT: ${r.len().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-for.yo` (negative, E0911): inside `for(&xs, e => …)`, `run(&mut ({ m : &mut xs }() => …))` grows `xs`, then `e`
  is read. Accepted, heap-use-after-free.
- `…-pos.yo` (positive control): `r`'s last use precedes the closure, which lives in a block. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape (a `&` loan of `xs`/`opt`/`s` live across the entry) | Verdict | Correct |
| --- | --- | --- |
| `r := first(&xs)`, then a named closure `{ m : &mut xs }` grows `xs` | accepted, UAF | E0911 |
| the same closure passed as a temporary, `run(&mut ({ m : &mut xs }() => …))` | accepted, UAF (ledger) | E0911 |
| inside `for(&xs, e => …)` | accepted, UAF | E0911 |
| inside `match(&opt, .Some(v) => …)`, the closure sets `m.* = .None` | accepted; `v` reads `OUT: 0` (ledger) | E0911 |
| in a `self : &mut Self` method, `{ m : &mut self.items }` | accepted, UAF (ledger) | E0911 |
| a loan from before a loop, the closure runs inside it | accepted, UAF (ledger) | E0911 |
| the pun `{ &mut xs }`; a holder of `&xs` made first and passed beside the closure | accepted (ledger) | E0911 |
| control: `grow(&mut xs)` in the closure's place | E0911 ("Cannot write `xs` here: `r` borrows `xs`") | E0911 |
| control: a live local `w := &mut xs`, then `{ m : &mut xs }` | E0911 ("Cannot read `xs` here") | E0911 |

## Root cause

`_evaluate_capture_list` (`src/evaluator/values/anonymous_function.yo`) handles a borrow entry by evaluating its
place with `evaluate_expression_raw`, which reaches the root identifier as a plain read, then `require_expr_not_consumed`
and, for `&mut`, `place_require_mut` (is the place declared writable). No step registers the entry as a `&mut`
access of the place against the live local loans: there is no `local_borrow_access(…, Write, …)` or
`local_borrow_write_expr` call on the entry's place. A read conflicts with a live `&mut` loan (the second control's
E0911 is exactly that read) but not with a live `&` loan, so the `&` loan survives the entry. The capture's
`BorrowCaptureOuter` record (`note_borrow_capture_outer`) serves only stores through the capture, and the capture's
own freeze (`g_capture_freezes`) judges LATER accesses of `xs`, not loans that already exist.

## Expected

E0911 at the entry, naming `r`. A capture entry is R-LEND of its place
(`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` R-CLOSURE-LIT, and §5's row "`&place` / `&mut place` operand, incl. …
a capture entry … → R-LEND + `access(place, lend-mode)`"); `REFERENCES_AND_ORIGINS.md` O3 step 2: a live `&(T, p)`
conflicts with a "`&mut` borrow by name" of a place in `p`. The entry is exactly that `&mut` borrow, taken when the
literal is evaluated, whether or not the closure is ever called.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
`closure-mut-capture-while-shared` (E0911) in `tests/origins/corpus.tsv`; `tests/closure_capture_list.test.yo`
gains the named, temporary and `for(&xs, …)` forms as E0911 cases.

## Fix

The cluster-2 fix (audit §9: "an access reaches the loan table weaker than its mode, or not at all") adds one
helper, `access_place` / `access_variable` / `access_move` (`src/evaluator/utils.yo`): an access of a place in the
mode the operation declares (read, write, move, `&mut` lend) checked against every loan table the checker holds — the
local borrows and flow sets (E0911, `local_borrow_access`) and the closures' capture borrows (E0910,
`capture_freeze_access`, which now takes the access kind and compares the capture's field path with the accessed
place's).

A borrow entry of a capture list is R-LEND of its place, so `_evaluate_capture_list`
(`src/evaluator/values/anonymous_function.yo`) calls `access_expr(place, Exclusive)` for a `&mut` entry (`Read` for a
`&` one) when the literal is evaluated: E0911 "Cannot borrow with `&mut` `xs` here: `r` borrows …" for every form of
the family (named, temporary, inside `for(&xs, …)`, in a `&mut self` method), and E0910 against a live closure's
capture borrow.

Tests: `tests/origins/unsound/c2-mut-capture-entry-live-loan.yo`, `c2-mut-capture-entry-in-read-walk.yo`,
`c2-mut-capture-entry-in-method.yo` (E0911), `c2-mut-capture-entry-live-loan-pos.yo` (accept, ASan clean);
`tests/closure_capture_list.test.yo` "a capture-list `&mut` entry beside a live `&` loan is E0911".
