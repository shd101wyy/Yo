# `yo compile`: a missing solver fails verify+ builds, and a dangling `YO_Z3_PATH` counts as a solver

**Severity:** S2 — verify+ fails without Z3 despite the documented promise; a dangling `YO_Z3_PATH` is silently trusted

**Status: FIXED 2026-09-28** (branch `verify/requires-and-solver-fixes`). Found 2026-09-28 while designing
`plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`, which needs both
fixed before a proof may remove a guard (its Phase 0).

## Symptom (measured, `yo 0.2.45`, macOS arm64)

Fixture: `pragma(Pragma.VerifyOrAssert);`, plus `safe_div(a, b)` with
`requires(b != i32(0))`, called from `main`.

```text
$ YO_CACHE_DIR=$PWD/nocache yo compile p5b_vplus.yo --emit-c --skip-c-compiler   # rc 1
verify: no Z3 solver found — this file's verify-mode contracts need proofs (their runtime asserts are suppressed). ...

$ YO_Z3_PATH=/nonexistent/z3 yo compile p5b_vplus.yo --emit-c --skip-c-compiler  # rc 0
  ok       fn@p5b_vplus.yo:3 [verify+] — 1 obligation(s) proved
```

## Two defects

1. **The missing-solver rule ignores the mode.** `_run_contract_verification`
   (`src/main.yo`) returns `false` whenever `strict_missing_solver` is set and
   the solver is `Installable`, for any non-empty task list. A `verify+`
   file's runtime asserts are *not* suppressed: the splice is kept and only
   proved `ensures` are stripped. So the message is wrong for it, and
   `plans/backlog/FORMAL_VERIFICATION.md` §"Acquisition" promises "a missing
   solver never fails a `verify+` build". Only `verify`-mode tasks should
   fail the compile. `verify+` should fall back and keep every assert.
2. **A dangling `YO_Z3_PATH` resolves as a solver.** `discover_z3`
   (`src/verifier/z3.yo`) returns the override without checking that the
   file exists, so `resolve_solver_sync` reports `Resolved`. `run_vc_query`
   then consults the verify cache *before* running the binary, and a warm
   cache answers `proved` with no solver present. A cold cache instead gives
   `solver-error` per obligation. The verdicts, and anything built on them,
   then depend on cache state rather than on the solver.

## Fix

- Make the missing-solver failure fire only when some task's `mode` is
  `"verify"`.
- In `discover_z3`, map a non-existent override to `InvalidPath` through the
  existing `_z3_exists_sync`.

## Tests to add with the fix

Two cli-cases:

- The verify+ fixture under an empty `YO_CACHE_DIR` compiles with rc 0, and
  its C still contains the `requires failed` entry assert.
- `YO_Z3_PATH=/nonexistent/z3` gives the `solver path ... does not exist`
  error, whatever the cache holds.

## Resolution

- `_run_contract_verification` (`src/main.yo`) fails a solver-less compile
  only when some task's mode is `verify` (`needs_proofs`). A `verify+`-only
  compile prints `verify: no Z3 solver found — verify+ contracts keep their
  runtime asserts, so nothing is proved …` and succeeds. The verify-mode
  message now says the *ensures* clauses need proofs, which follows from the
  companion fix (`requires` asserts are kept in `verify` mode:
  `issues/fixed/verify-mode-requires-is-unchecked-when-the-caller-is-outside-the-subset.md`).
- `resolve_solver_sync` (`src/verifier/driver.yo`) checks that the path
  `discover_z3` returns exists. A dangling `YO_Z3_PATH` is `InvalidPath`,
  which prints `solver path '…' does not exist`, fails a `verify`-mode compile,
  and never reaches the verify cache. `yo verify` resolves through the same
  function, so it is covered too.

## Verification

- cli-case `verify-plus-compiles-without-a-solver`: rc 1 with the old
  verify-mode message under the pre-fix compiler, rc 0 with the verify+ hint
  after. The sandbox `HOME` has no cached solver.
- cli-case `verify-dangling-z3-path-is-an-error`
  (`env=YO_Z3_PATH=/nonexistent/z3`, a `verify`-mode fixture): the pre-fix
  compiler ran the queries and reported `SOLVER-ERROR … z3 exited with
  status 127`. It now reports `solver path '/nonexistent/z3' does not exist`,
  rc 1.
