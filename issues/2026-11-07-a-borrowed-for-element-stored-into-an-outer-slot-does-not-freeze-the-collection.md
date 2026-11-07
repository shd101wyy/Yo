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

O-1, v0.2.76 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus row `for-element-stored`; the repro under `tests/origins/unsound/`.
