# A field write of a reference does not join the holder's flow set

**Severity:** S1 — use-after-free in safe code: `h.o = .Some(&y)` lets `h` outlive `y`

Found 2026-11-08 while building O-3's capture-store rule (the H2e program stores through a captured holder's field).

## Reproducer

Program: `issues/repros/2026-11-08-a-field-write-of-a-reference-does-not-join-the-holders-flow-set.yo`.

`yo check` accepts it (tree binary at develop `a25a71ee1`). Compiled with `--sanitize address --allocator system` and
run, ASan reports `heap-use-after-free`. With a spelled holder (`h : S(z0)`, field `Option(&(String, z0))`), storing
`&y` was accepted too, a widening of the spelled origin.

## Root cause

BORROW_CHECKER_COMPLETENESS.md §5's place-write row (`p = v`, `p.* = v`, `p.f = v`, `xs(i) = v`) was built for the
whole-holder forms only. `bind_join` runs from the atom `=` path (`src/evaluator/exprs/assignment.yo`); the field and
index path checked the write access and never joined the root holder's flow set or checked the field type's spelled
origins.

## Fix

`place_write_join` (`src/evaluator/utils.yo`) runs on the field/index path. It grows the root holder's flow set by
`origin_of(value)`, GEN only, because the holder's other parts keep what they hold. It checks the subset against the
origins the written place's type spells, and its §7 scope check gives E0911 at the store. A root that is a `&mut`
capture is the outer place (VERDICTS-37 Q3).

## Test that pins it

`tests/origins/unsound/field-write-block-local.yo` (E0911) and `field-write-spelled-holder.yo` (E0923), with their
ASan-clean positive twins.
