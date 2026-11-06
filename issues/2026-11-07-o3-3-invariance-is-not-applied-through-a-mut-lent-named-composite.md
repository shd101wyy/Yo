# O3-3 invariance is not applied through a `&mut`-lent named composite

**Severity:** S1 — use-after-free in safe code: a callee widens the origin stored in a caller's named holder struct

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-o3-3-invariance-is-not-applied-through-a-mut-lent-named-composite.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. Also `p31_slot_invariance.yo`, `p32b_field_store_widen.yo`.

## Root cause

`lend_through`'s exact unification exists only for a bare `&mut Option(&(T, r))` pointee; a `&mut Slot(p)` / `&mut S(p)` argument does not substitute `p` from the argument's type.

## Fix

O-2, v0.2.76 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus rows `store-widen-named-holder`, `store-widen-covariant-field`; the repro under `tests/origins/unsound/`.
