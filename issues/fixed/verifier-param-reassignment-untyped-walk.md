# Verifier: hollow bodies from swallowed def-time failures were mis-reported as "untyped expression"

- **Status:** FIXED on feat/fv5-twostate (2026-09-11); this file rewrites
  the original (mis-diagnosed) issue text — see "What the original got
  wrong" below.
- **Component:** verifier diagnostics × the def-time trial swallow
  (`src/evaluator/calls/function_type.yo` ↔ `src/verifier/`)
- **Severity:** diagnostics quality (a loud, WRONG error message); the
  underlying soundness hole it guarded is real and fixed with it (below)

## What actually happens

A verify-target function whose DEFINITION-TIME body trial throws has its
error swallowed at load (the trial's `catch` disposition), the body never
gets `ExprInfo`, and the verifier then walks a hollow AST and reports the
meaningless `untyped expression @ begin(...)`. `yo check` on the same file
reports the REAL error loudly — the masking is specific to the verify
pipeline (load + walk).

Two concrete triggers (both found via the standalone driver):

1. `x = i32(5)` where `x` is a plain parameter — **E0902 "Cannot
   reassign x"**: parameter reassignment is ILLEGAL Yo. (The original
   issue text below assumed this was legal code hitting a table-keying
   bug — wrong; the walk never had a chance because the evaluator
   rejected the body.)
2. A bare `assert(...)` without `{ assert } :: import("std/assert")` —
   **E0401 "Variable assert not found"** (`assert` is a std export, not
   a prelude global — every existing verify fixture imports it).

## The fix (feat/fv5-twostate)

- `function_type.yo` records the swallowed message at the flow site,
  keyed by the task's `fn_id` (`record_verify_task_def_eval_failure`).
- `driver.yo` reports it verbatim: `body's definition-time evaluation
  failed (swallowed at load): <the real E0902/E0401 message>`.
- `vc.yo` additionally special-cases a body ROOT with no table entry
  (failure table empty, e.g. older tasks) with a dedicated
  "definition-time evaluation did not complete" subset error instead of
  "untyped expression".
- Guard fixtures: `tests/spec/fixtures/negative/def_eval_swallowed.yo`
  (E0902) asserts the cause is named;
  `tests/internal/verifier_twostate.test.yo` covers both channels.

## The adjacent real soundness hole (found on the way, same PR)

Investigating trigger 2 with the import fixed exposed that `old(...)`
still walked as IDENTITY (the V3 straight-line stance) — but V4
legalized `=` reassignment of locals, so `old(y)` read the CURRENT
binding: `y := x; y = (y + 1); assert(y == old(y))` was PROVED while
being false for every x (a false PROOF, confirmed end-to-end against
z3). The same PR replaces identity with the two-state ENTRY-snapshot
walk (`ctx.entry_vars`), gates `old(name)` of names not bound at entry,
and adds `valid/two_state_old.yo` + `negative/two_state_old_gate.yo`.

## What the original issue text got wrong (kept for the record)

The original text hypothesized "the task body holds fresh node ids that
don't match the ExprInfoTable because parameter reassignment rewrites
the body". Measurement (`[trial]`/`[swallow]` under `YO_DEBUG_SWALLOW=1`,
plus a table-membership diagnostic driver) showed the body is never
rewritten: the def-time trial throws E0902 (param reassignment is simply
illegal), everything after the failing statement never gets info, and
the load swallows the whole thing. The fix direction the original
proposed (fix the task capture/re-keying) was therefore unnecessary.
