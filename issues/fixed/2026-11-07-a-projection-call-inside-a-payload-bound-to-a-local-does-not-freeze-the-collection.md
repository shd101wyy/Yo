# A projection call inside a payload (`Option(&i32).Some(xs.index(0))`) bound to a local does not freeze the collection

**Severity:** S1 — use-after-free in safe code: the collection grows while the bound payload reference is live (new on develop: the v0.2.75 seed rejects the program for a type reason; N1e-2b's read rule admits the payload)

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-projection-call-inside-a-payload-bound-to-a-local-does-not-freeze-the-collection.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`.

## Root cause

`local_borrow_may_bind_projection_stmt` handles `r := call()` and `w := v`, not a constructor wrapping a call (R-CALL under R-COMP).

## Fix

Fixed by O-1 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3, §8): R-CALL under
R-COMP — `origin_of` recurses into a constructor's components and into a projection
call's root arguments, so `Option(&i32).Some(xs.index(0))` carries `xs`, and `bind`
freezes it for the holder's live range: the later `xs.push` is E0911.

## Test that pins it

corpus row `projection-in-payload`; `tests/origins/unsound/p60-projection-in-payload.yo`
(G-B: rejected with E0911; the positive twin runs clean under ASan).
