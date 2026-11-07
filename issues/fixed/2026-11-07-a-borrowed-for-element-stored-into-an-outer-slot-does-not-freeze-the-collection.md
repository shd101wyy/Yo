# The borrowed-`for` element stored into an outer slot does not freeze the collection past the loop

**Severity:** S1 — use-after-free in safe code: the collection grows after the loop and the stored element reference dangles

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-borrowed-for-element-stored-into-an-outer-slot-does-not-freeze-the-collection.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. (after 1,000 pushes).

## Root cause

The element binding's origin (`xs`) is not propagated by `=` into the outer slot (the `for` lowering's `bind` obligation).

## Fix

Fixed by O-1 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3, §7, §8): the `=` join
gives the outer slot the element's origin. R-READ finds a binding's entries from a USE
of its name (name and module — no shadowing exists), R-COMP recurses into atom payloads
(`.Some(x)`), and the join resolves the roots to GROUND places through the loop's hidden
collection borrow (`x` → `xs`). The flow set lives in its own table, cleared per function
body rather than per block (the loop's blocks end before the later `xs.push`), and
`local_borrows_active()` counts it, so the post-loop write conflicts: E0911.

## Test that pins it

corpus row `for-element-stored`; `tests/origins/unsound/p59-for-element-stored.yo`
(G-B: rejected with E0911; the positive twin runs clean under ASan).
