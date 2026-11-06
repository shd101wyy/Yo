# Reassigning a `mut` holder of a named origin-parameterized struct is E0908 "`h` is a `&` borrow, which is read-only"

**Severity:** S2 — a valid program is rejected; it blocks G2, whose cursors are reassigned

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-reassigning-a-mut-holder-of-a-named-origin-struct-is-a-false-e0908.yo`.

`yo check` reports `error[E0908]: Cannot assign to \`h\`: \`h\` is a \`&\` borrow, which is read-only.` The `Option(&i32)` form works (`tests/origins/reference_read_rule.test.yo`, "A mut holder of a shared lend is writable"). Also `p08d_holder_reassign_same.yo`.

## Root cause

The read-only predicate treats a named holder binding as a `&` reference binding (`variable_is_reference_binding` or its N2b holder flag).

## Fix

its own small PR, v0.2.76 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

a positive test beside the `Option` one in `tests/origins/reference_read_rule.test.yo`; under O-1 `p08c` then becomes E0911 at the inner drop.
