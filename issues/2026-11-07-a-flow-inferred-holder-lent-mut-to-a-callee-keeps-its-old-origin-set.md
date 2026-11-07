# A flow-inferred holder lent `&mut` to a callee that stores a wider origin keeps its old origin set

**Severity:** S1 — use-after-free in safe code: a callee stores a reference to a shorter-lived root into the caller's `Option(&T)` slot, the root dies, and the slot is read

Found 2026-11-06 by the advisor's audit of the origin and borrow-checking design (VERDICTS-30), filed with the plan
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` (§10).

## Reproducer

Program: `issues/repros/2026-11-07-a-flow-inferred-holder-lent-mut-to-a-callee-keeps-its-old-origin-set.yo`.

`yo check` accepts it ("evaluator OK", tree binary at develop `8d475cd81` and later); compiled with `--sanitize address --allocator system` and run, ASan reports `heap-use-after-free`. Also: `p05_origin_store_flow.yo`, `p33_loop_store.yo` (the loop form) in the advisor's probe set.

## Root cause

`lend_through` does not write the solved origin set back to a flow-inferred holder (`REFERENCES_AND_ORIGINS.md` §7, "A local's flow set after a `&mut` lend", is unbuilt); only a bare `&mut Option(&(T, r))` pointee is unified, and the slot keeps the set it had before the call, so the root's scope-end drop is not a conflict.

## Fix

O-2 (`lend_through` with write-back), v0.2.76 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §8–§9).

## Test that pins it

corpus rows `flow-slot-lent-mut`, `flow-slot-lent-mut-loop`; the repro under `tests/origins/unsound/` (G-B).
