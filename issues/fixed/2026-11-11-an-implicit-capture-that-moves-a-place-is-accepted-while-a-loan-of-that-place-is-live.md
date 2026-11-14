# An implicit capture that moves a place is accepted while a loan of that place is live

**Severity:** S1. A closure literal that names `xs` in its body (`() => xs.len()`, no capture list) moves `xs` into
its capture record, because `ArrayList` is not implicitly copyable. That move is accepted while `r := first(&xs)` or a
closure's `{ r : &xs }` capture is live; the closure's drop frees the elements and the later read of `r` (or call of
the first closure) is a heap-use-after-free. Pre-existing: v0.2.76 accepts it too. The explicit entry `{ xs }` in the
same position is E0911.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A34). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-an-implicit-capture-that-moves-a-place-is-accepted-while-a-loan-of-that-place-is-live.yo`
(negative, expects E0911):

```yo
first :: (fn(xs : &ArrayList(String)) -> &String)(&xs(usize(0)));
eat :: (fn(f : &mut Impl(FnMut() -> usize)) -> usize)(f());
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  r := first(&xs);
  n := eat(&mut (() => xs.len()));
  println(`OUT: ${n.to_string()} ${r.len().to_string()}`);
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-closure.yo` (negative, E0910): the loan is a first closure's `{ r : &xs }` capture; the second literal's implicit
  capture moves and drops `xs`, then the first closure is called. Accepted, heap-use-after-free.
- `…-pos.yo` (positive control): `r`'s last use precedes the capturing literal. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `r := first(&xs)` live; `eat(&mut (() => xs.len()))` | accepted, UAF | E0911 |
| the same with a named `(f : Impl(FnOnce() -> usize)) = (() => xs.len())` in a block | accepted, UAF (ledger) | E0911 |
| a closure's `{ r : &xs }` live; `eat(&mut (() => xs.len()))` | accepted, UAF | E0910 |
| the explicit by-value entry `{ xs }` with `r` live | E0911 ("Cannot move `xs` here: `r` borrows `xs`") | E0911 |

## Root cause

An explicit `{ xs }` entry and a by-value argument move through `set_expr_as_consumed` (`src/evaluator/utils.yo`),
which calls `check_capture_freeze_access(&v, true, …)` and `local_borrow_access(…, LocalBorrowAccess.Move, …)` before
marking the binding consumed. An implicit capture moves through a different path:
`generate_captured_variable_dup_expressions` (`src/evaluator/utils/closure.yo`) sends every capture whose type
`type_requires_explicit_copy` to `move_captured_explicit_copy_variable` (`src/evaluator/utils.yo`). That function
checks only that the variable is not already moved and may be moved (owning, not a borrow or module-level), then sets
`consumed_at_token`. It calls neither the local-borrow access check nor the capture-freeze check, so the move is
invisible to every live loan of `xs`.

## Expected

E0911 at the literal, naming `r` (E0910 naming the closure for the `-closure` form), the same verdict the explicit
`{ xs }` gets. `REFERENCES_AND_ORIGINS.md` O3 step 2: a live `&(T, p)` conflicts with a "move" of a place in `p`; an
implicit capture of a non-`Copy` value is a move (plans/VALUES_BY_DEFAULT.md §3.4, §3.7, quoted in
`generate_captured_variable_dup_expressions`). The fix makes `move_captured_explicit_copy_variable` perform the same
two access checks `set_expr_as_consumed` does.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
`closure-implicit-move-while-shared` (E0911) in `tests/origins/corpus.tsv`; `tests/closure_capture_list.test.yo`
gains the implicit form beside the explicit `{ xs }` E0911 case.

## Fix

The cluster-2 fix (audit §9: "an access reaches the loan table weaker than its mode, or not at all") adds one
helper, `access_place` / `access_variable` / `access_move` (`src/evaluator/utils.yo`): an access of a place in the
mode the operation declares (read, write, move, `&mut` lend) checked against every loan table the checker holds — the
local borrows and flow sets (E0911, `local_borrow_access`) and the closures' capture borrows (E0910,
`capture_freeze_access`, which now takes the access kind and compares the capture's field path with the accessed
place's).

`move_captured_explicit_copy_variable` (`src/evaluator/utils.yo`) calls `access_variable(…, Move)` on the moved
binding before marking it consumed, the two checks `set_expr_as_consumed` makes for the explicit `{ xs }` entry.

Tests: `tests/origins/unsound/c2-implicit-capture-move-live-loan.yo` (E0911), `c2-implicit-capture-move-ref-capture.yo`
(E0910), `c2-implicit-capture-move-live-loan-pos.yo` (accept, ASan clean); `tests/closure_capture_list.test.yo` "an
implicit capture that moves a place is checked against live loans".
