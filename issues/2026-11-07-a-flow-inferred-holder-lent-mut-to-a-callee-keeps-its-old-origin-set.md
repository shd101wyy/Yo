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

Fixed by O-2 (`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §3, §7, §8): at every
call, `lend_through` treats a `&mut`-lent flow-inferred holder as an inference variable.
Its pointee's unfixed origin parameters — and its type parameters (`dst : &mut
Option(T)` with `T := &S`) — are solved to the union of what the call's other
same-parameter arguments carry, and the solved set is written back to the caller's
holder (the `=` join's core: kill, ground, gen). A ground root whose block ends before
the holder's last use is E0911 at the call, the flow form of the scope-end drop
conflict.

## Test that pins it

corpus rows `flow-slot-lent-mut`, `flow-slot-lent-mut-loop`, `generic-slot-lent-mut`;
`tests/origins/unsound/h1r-flow-slot-lent-mut.yo` (G-B: rejected with E0911; the
positive twin runs clean under ASan).
