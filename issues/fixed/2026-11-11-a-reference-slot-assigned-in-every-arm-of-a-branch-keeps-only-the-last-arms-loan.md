# A reference slot assigned in every arm of a branch keeps only the last arm's loan

**Severity:** S1. `cond(c => { h = .Some(&x); }, true => { h = .Some(&y); }); x = …; use(h)` passes `yo check`:
after the branch `h` is known to borrow only `y`, so the write of `x` is accepted while `h` may still point into
it. With a boxed payload the read is a heap-use-after-free; with a plain `String` it silently reads the new value
through the stale reference. Pre-existing: v0.2.76 accepts every reproducer too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A18). Confirmed on develop `64f33c710`.

## Reproducers

`tests/origins/unsound/a18-every-arm-assigns-holder.yo` (filed under `issues/repros/` with this doc's name, moved with the fix; the `…-` twins below likewise)
(negative, expects E0911; `flag()` is true at run time):

```yo
main :: (fn() -> unit)({
  mut(x) := Box.new(L());
  mut(y) := Box.new(L());
  mut(h) := Option(&String).None;
  cond(
    flag() => {
      h = match(&x, Box(s) => Option(&String).Some(s));
    },
    true => {
      h = match(&y, Box(s) => Option(&String).Some(s));
    }
  );
  x = Box.new(String.from("q"));
  match(h, .Some(r) => println(`OUT: ${r.*}`), .None => ());
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-minimal.yo` (negative, E0911): `h = .Some(&x)` / `h = .Some(&y)` over plain `String`s; prints `OUT: q`, the
  value written after the loan should have frozen `x`.
- `…-match.yo` (negative, E0911): the same through the arms of `match(flag(), true => …, false => …)`; `OUT: q`.
- `…-pos.yo` (positive control): `x` is written after `h`'s last use; runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| every arm of a `cond` assigns `h`; then the FIRST arm's root is written | accepted (UAF with a box) | E0911 |
| the same with a `match` | accepted | E0911 |
| the same; then the LAST arm's root `y` is written | E0911 naming `h` | E0911 |
| only one arm assigns `h` (`cond(c => { h = .Some(&x); }, true => ())`), then `x` is written | E0911 | E0911 |
| `mut(h) := …&y…; if(c, { h = …&x…; }); x = …` | E0911 | E0911 |
| the same; then `y`, the root from before the `if`, is written | E0911 | E0911 |
| one arm kills an entry GENed before the branch (`h = …&y…; if(c, { h = …&x…; }); y = …`) | accepted | E0911 |

So the loss needs a `=` in each of two sibling arms: one arm's assignment discards the other's loan.

## Root cause

Confirmed in `src/evaluator/utils.yo`. A whole-holder assignment `h = v` goes through `bind_join` to
`bind_join_roots_for`, whose step "KILL + GEN (§7): the assignment REPLACED the holder's value, so its flow set
is the new value's, never the union with the old one" calls `local_borrow_joins_clear(h)` before registering
the new roots in `g_local_borrow_joins`. That table is one flow-insensitive list: the arms of a `cond` or `match`
are evaluated in textual order, so the second arm's KILL removes the entry the first arm's GEN added, and
nothing joins the arms' sets at the merge point. The kill is a strong update applied as though the second arm
ran after the first. The one-arm and pre-branch rows survive because nothing on another path kills their
entries (the `:=` initializer's loan lives in the decision-18 record, which `local_borrow_joins_clear` does not
touch).

## Expected

E0911 at `x = …`, naming `h`. `plans/backlog/BORROW_CHECKER_COMPLETENESS.md`, `bind`: "a holder's loans are the
join over reaching definitions (loops to a fixpoint)", and R-ARM: "the union over the arms". A KILL is sound only
on the path where the assignment ran: at the end of a branch the holder's set is the union of the arms' sets,
each arm starting from the set before the branch.

## Fix

Fixed by the cluster-4 branch `fix/c4-flow-join`. Each entry of `g_local_borrow_joins` now carries the sequence number of its GEN and the count of exits (`break`, `continue`, `return`, `unwind`) seen before it (`LocalBorrowInfo.gen_seq` / `gen_exits`, `src/evaluator/utils.yo`). The evaluator opens a flow region where control may skip code: each `cond` condition after the first and each runtime arm (`exprs/cond.yo`), each `match` arm (`exprs/match.yo`), a loop's condition and body (`exprs/while.yo`), the skippable operand of `&&` / `||` (`builtins/and_or.yo`) and a function body (`exprs/begin.yo`). The KILL of a whole-holder assignment (`local_borrow_joins_clear`) removes only the entries GENed inside the innermost open region with no exit between the GEN and the KILL: those are the entries every path to the assignment carries. An entry from a sibling arm, from before the branch, or from before an exit survives, so the holder's set at a merge point is the union over the paths into it.

The second arm's `h = …&y…` therefore leaves the first arm's `h -> x` entry in place, and `x = …` after the branch is E0911 naming `h`. The same rule covers a kill in ONE arm of an entry GENed before the branch (`mut(h) := …; h = …&y…; if(c, { h = …&x…; }); y = …`), a row the family table did not have: the other path still carries `h -> y`, and the write of `y` is E0911.

## Test

`tests/origins/unsound/` (G-B, `scripts/origins-unsound.sh`): `a18-every-arm-assigns-holder` (the boxed form), `-minimal`, `-match` (E0911 each) and `-pos`; `a18-prebranch-entry-killed-in-one-arm` (E0911) and its `-pos` twin. Corpus row `holder-assigned-in-both-arms-then-first-root-written` (E0911) in `tests/origins/corpus.tsv`, encoded in `tests/origins/model_corpus.test.yo`.
