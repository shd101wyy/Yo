# `yo compile`: a missing solver fails verify+ builds, and a dangling `YO_Z3_PATH` counts as a solver

**Status: OPEN.** Found 2026-09-28 while designing
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
