# What the implicit-copy audit and the explicit-copy migration cover after B8

**Kind:** design question: an open decision, not a defect. Filed 2026-10-27 while preparing B8's goldens (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.5, "Goldens").

## The question

Two transition tools find the implicit copies that unique ownership turns into explicit ones:

- `YO_AUDIT_IMPLICIT_COPY=1` prints one line per dup the evaluator inserts for an RC-bearing value whose source stays alive (cli-case `audit-implicit-copy-lists-copies-of-live-values`).
- `yo fix --migrate explicit-copy` (Generation A2) inserts `.clone()` at those dups (22 `fix-migrate-explicit-copy*` cli-cases).

Both record a site where the evaluator inserts a DUP. Every one of their fixtures copies a `String` or an `ArrayList`. Once B8 makes both types values, those copies are no longer dups: each is E0901 ("use of moved value"), and evaluation stops at the first one. Measured on `vbd/b8-arraylist-string-flip` with a develop binary (`yo-tree`, develop 476cfb700 plus 1.2's S2 hunks), whose std is the flipped one:

- all 22 `fix-migrate-explicit-copy*` cases end with `fix: main.yo does not evaluate; its copies are migrated only as far as evaluation reached` and `inserted 0 .clone() call(s)` (rc 1 instead of 0);
- the audit case lists no `main.yo` line at all (`stdout_keep_match matched nothing`).

Re-recording those goldens would freeze the tools in a state where they do nothing. So the question is what the tools are for after B8, and what their fixtures copy.

## Options

1. **Keep the tools and move the fixtures to a type that still dups.** `HashMap`, `HashSet`, `Deque` and the rest stay `ref` until B9–B11, and a `ref(struct(...))` holding an `Rc` stays one after. The tools keep their coverage, and each later flip moves the fixtures again. The tools are retired with the last flip.
2. **Teach both tools to read E0901.** In migrate mode, an E0901 at a copy of a type that has `Clone` is recorded as a site instead of stopping evaluation, and the migration inserts the clone. This is what `vbd-logs/b8/scripts/unmask.py` does from outside the compiler today. It gives users upgrading across B8 a working `yo fix`, at the cost of an evaluator mode that continues past a type error.
3. **Retire both tools at B8.** Delete the 23 cases and the two code paths. A user crossing B8 reads the E0901 help, which already names `.clone()`.

## Recommendation

Option 1 for B8 itself, then Option 3 after B11. The tools' remaining users are the flips still to come (B9–B11), and every one of those types is still `ref`, so Option 1 keeps a tested tool for exactly the steps that need it with fixture edits only and no compiler change. Option 2 adds an evaluator mode that must continue past an error. That is the behaviour the probe tooling needed a whole script for, and a user crossing B8 is already told the fix by E0901's own help. After B11 nothing dups implicitly except `Rc` handles, whose copies are the point of `Rc`. The tools then have nothing left to find and should be deleted with their cases, as the no-backward-compatibility rule asks.

The five `inout-*-panics` cases are a different matter and need no decision. A static E0901 replaces each panic (the list cannot be aliased once it is a value), and their goldens are re-recorded on the B8 branch with `stdout_keep_match` on the E0901 line.
