# A write that precedes a lend in a loop body is not checked against the loan the back edge carries

**Severity:** S1. In `while(…, { if(i == 2, { x = …; }); if(i == 1, { h = .Some(&x.*); }); … })` with `h` read
after the loop, `yo check` accepts the write of `x` on iteration 2 although `h` still holds the loan of `x` that
iteration 1 made: the old Box is dropped and the read of `h` after the loop is a heap-use-after-free. Pre-existing: v0.2.76
accepts it too. Writing the same two statements in the other order (lend, then write) is E0911.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A19, part b). Confirmed on develop `64f33c710`. Sibling:
`issues/2026-11-11-a-reference-to-a-per-iteration-local-stored-in-an-outer-slot-survives-into-the-next-iteration.md`
(A19a, a holder's liveness around the back edge). Both are the missing loop fixpoint; the checks that miss them
differ, so a fix of one does not fix the other.

## Reproducers

`issues/repros/2026-11-11-a-write-that-precedes-a-lend-in-a-loop-body-is-not-checked-against-the-loan-the-back-edge-carries.yo`
(negative, expects E0911):

```yo
L :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
main :: (fn() -> unit)({
  mut(x) := Box.new(L());
  mut(h) := Option(&String).None;
  mut(i) := 0;
  while(i < 3, {
    if(i == 2, {
      x = Box.new(String.from("q"));
    });
    if(i == 1, {
      h = .Some(&x.*);
    });
    i = (i + 1);
  });
  match(h, .Some(r) => println(`OUT: ${r.*}`), .None => ());
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-string.yo` (negative, E0911): the ledger's minimal j06b, `h = .Some(&x)` over the `String` itself. No memory
  error — `x`'s slot is rewritten in place — but the frozen `h` reads the value written on iteration 2 (`OUT: q`).
- `…-holder.yo` (negative, E0911): a struct holder; `b = mk()` at the top of every iteration frees the Box the previous
  iteration's `h = H(r : &b.*, …)` points into, and `h` is read after the loop: heap-use-after-free.
- `…-pos.yo` (positive control): the holder is read at the top of the body, then the root is written, then the holder
  is re-pointed. The carried loan is dead at the write (the holder is overwritten before its next read); a fix that
  re-checks the body against carried loans must keep accepting it, so the fix needs liveness, not only the loan set.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| write of the Box `x`, then a conditional `h = .Some(&x.*)` later in the body, `h` read after the loop | accepted, heap-use-after-free | E0911 |
| the same over the `String` `x` itself, `h = .Some(&x)` (ledger j06b, `…-string.yo`) | accepted; reads the new value | E0911 |
| the same through a borrowed match, `h = match(&x, Box(s) => Option(&String).Some(s))` (ledger j06) | accepted, heap-use-after-free | E0911 |
| a struct holder over `&b.*` (holders j03b); over `&b` with an `Rc` payload (j03, reads a live value) | accepted | E0911 |
| the lend first, then the write, in one body (ledger j05, l03; l04 with a `continue` between) | E0911 | E0911 |
| read, write, re-point in that order (holders j07, `…-pos.yo`) | accepted | accept |

The N0 corpus row `loop-join-push` (`tests/origins/corpus.tsv`, "the flow set must be a fixpoint over the back edge")
is this shape with the loan held by an `ArrayList(&i32)`. It is rejected today only by the container wall
("carries an origin inside a container", N2c), not by the loop join, so it pins nothing about the back edge. Add the
`Option(&T)`-slot twin — this issue's repro, `loop-join-option-slot` (neg, E0911 at `x = …`) — and `…-pos.yo` as its
positive twin; the row survives N2c lifting the wall.

## Root cause

Accesses are checked in evaluation order, once: `local_borrow_access` (`src/evaluator/utils.yo`) scans
`g_local_borrows` and `g_local_borrow_joins` at the moment the write is evaluated. The loop body is evaluated a single
time (`evaluate_while`, `src/evaluator/exprs/while.yo`), so when `x = …` is checked the entry `h → x` does not exist
yet; `bind_join_roots_for` registers it later in the same pass, at `h = .Some(&x)`. The entry's range would cover the
write — it starts at `h`'s declaration token and ends at `h`'s last use after the loop — but no access is re-checked
against entries registered after it. `check_loop_flow` (`src/evaluator/utils.yo`) is the only back-edge rule, and it
joins move states, never loans.

## Expected

E0911 at `x = Box.new(String.from("q"))`: the loans live at the end of the body (and at each `continue`) are live at the loop
head, so they are checked against every access the body makes before re-pointing their holder. `BORROW_CHECKER_COMPLETENESS.md`
§3: "a holder's loans are the join over reaching definitions (loops to a fixpoint)"; `REFERENCES_AND_ORIGINS.md` §4:
the per-body set is "joined at control-flow merges and iterated to a fixpoint over loops". The reference checker
(`tests/origins/model.yo`) has the fixpoint; one of its five ablations switches it off.

## Test

With the fix: both negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`loop-join-option-slot` (neg, E0911) and `loop-join-option-slot-after` (pos) in `tests/origins/corpus.tsv` beside
`loop-join-push`, encoded for the model in `tests/origins/model_corpus.test.yo`.
