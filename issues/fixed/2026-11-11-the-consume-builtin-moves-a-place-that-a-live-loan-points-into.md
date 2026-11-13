# The `consume` builtin moves a place that a live `&` loan points into

**Severity:** S1. `r := xs.index(usize(0)); consume(xs); println(r.*)` passes `yo check`: `consume(xs)` releases
the list while `r` still points into it, and `r` is read (ASan: heap-use-after-free). The same holds for an `Rc`
handle (`r := h.as_ref(); consume(h)`), a read-walk element stored in a slot, and a plain `r := &s`. Passing the
same value to a user by-value function is E0911. Pre-existing: v0.2.76 accepts the list form (it has no
`Rc.as_ref`).

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A13). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-the-consume-builtin-moves-a-place-that-a-live-loan-points-into.yo` (negative, expects
E0911):

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("hello-world-hello-world-hello-world"));
  r := xs.index(usize(0));
  consume(xs);
  println(`OUT: ${r.*}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-rc.yo` (negative, E0911): `r := h.as_ref(); consume(h);` with `h` the only `Rc` handle:
  heap-use-after-free.
- `…-pos.yo` (positive control): `r`'s last use is before the `consume`. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `r := xs.index(usize(0)); consume(xs); r.*` | accepted, UAF | E0911 |
| `r := h.as_ref(); consume(h); r.*` (`Rc`) | accepted, UAF | E0911 |
| `for(&xs, x => { slot = .Some(x); }); consume(xs);` then `slot` read | accepted, UAF | E0911 |
| `r := &s; consume(s); r.*` (`String`) | accepted; prints `OUT: ` with an empty string, no ASan report | E0911 |
| `drop(xs)` (the prelude's `drop :: (fn(generic(T : Type), sink(x) : T) -> unit)`) while `r` lives | E0911 "Cannot move `xs` here" | — |
| `eat(h)` with `eat :: (fn(h : Rc(String)) -> unit)` while `r := h.as_ref()` lives | E0911 "Cannot move `h` here" | — |
| a generic by-value `eat(xs)` while `r := xs.index(…)` lives | E0911 (ledger) | — |
| `consume(xs)` while `y := &mut xs` lives | E0911 "Cannot read `xs` here" | E0911 (a move, not a read) |

The last row is rejected for the wrong reason: the argument is evaluated as a read, which a `&mut` loan forbids
and a `&` loan allows.

## Root cause

`evaluate_consume` (`src/evaluator/builtins/consume.yo`) evaluates its argument as an ordinary expression (a read)
and then marks the variable moved with `set_variable_as_consumed`, which records the move state and nothing else.
The by-value argument path goes through `set_expr_as_consumed` (`src/evaluator/utils.yo`) instead, which, when
`local_borrows_active()`, calls `local_borrow_access(local_borrow_place_of_variable(&v), LocalBorrowAccess.Move, …)`
— the E0911 "Cannot move `h` here" of the user-function row — and `check_capture_freeze_access`. `consume` skips
both, so no live loan ever sees the move. The prelude's `drop` is a by-value function and takes the checked path;
the internal `___drop` builtin (`src/evaluator/builtins/drop.yo`) calls `set_variable_as_consumed` the same way.

## Expected

E0911 at `consume(xs)`: `r` borrows `xs`. BCC's access table: "drops: scope end, reassignment, `drop(x)`, a consumed
argument … → `access(place, drop)`", and `REFERENCES_AND_ORIGINS.md` O3 step 4 (decision 18): "moves and drops are
accesses". `consume(x)` is a move whose value is released (`record_consume_release`), so it is a move access and a
drop access of `x`'s place, exactly as passing `x` to a by-value parameter is.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; a corpus row
beside `drop-root-while-borrowed` in `tests/origins/corpus.tsv`, and a case in `tests/move_only.test.yo` for the
`consume` of a borrowed local.

## Fix

The cluster-2 fix (audit §9: "an access reaches the loan table weaker than its mode, or not at all") adds one
helper, `access_place` / `access_variable` / `access_move` (`src/evaluator/utils.yo`): an access of a place in the
mode the operation declares (read, write, move, `&mut` lend) checked against every loan table the checker holds — the
local borrows and flow sets (E0911, `local_borrow_access`) and the closures' capture borrows (E0910,
`capture_freeze_access`, which now takes the access kind and compares the capture's field path with the accessed
place's).

`evaluate_consume` (`src/evaluator/builtins/consume.yo`) calls `access_move` on the consumed binding before marking
it moved, as `set_expr_as_consumed` (now `access_move` too) does for a by-value argument: `consume(xs)` beside a live
`r` is E0911 "Cannot move `xs` here: `r` borrows …", and the `&mut` row's verdict is now a move, not a read. The
internal `___drop` builtin is unsafe-only (`is_destroying_builtin_call_capable`) and unchanged.

Tests: `tests/origins/unsound/c2-consume-live-loan.yo`, `…-rc.yo`, `c2-consume-live-ref-binding.yo` (E0911) and
`c2-consume-live-loan-pos.yo` (accept, ASan clean); `tests/move_only.test.yo` "`consume` of a place a live `&` loan
points into is E0911".
