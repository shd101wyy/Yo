# `yo build` exited 0 when a step failed — in BOTH compilers

**Status: FIXED** 2026-08-10 (`src/build-runner.ts` `runBuild`,
`yo-self/build_runner.yo` `run_build`), with a differential case
(`tests/cli-cases/build-fail`). Found by P2.2's first self-hosted self-build:
the compile step died with 16 C errors, printed `Compilation error:
Compilation failed (exit 1)` — and the process exited **0**.

**A silent failure in the worst possible place.** P2.3 replaces CI's
`bun run build` with `yo build`; a build tool that exits 0 on a failed
compile would let every CI job pass while producing no binary.

## Root cause

Faithful porting of a TS bug. `executeNode` deliberately catches per-step
errors into `StepResult.success` so the DAG can finish and the summary can
show WHICH step broke — but nothing downstream ever read the results for
failure. TS's `runBuild` printed the summary and returned; the yargs handler
awaited it and node exited 0. yo-self mirrored the same shape
(`run_build` → `execute_dag` → optional summary → return). Verified
empirically on a broken fixture: TS rc=0, self-hosted rc=0.

The per-step catch is right; the missing piece was the final verdict.

## Fix

After the DAG (and after the optional summary, so the failure report still
prints), exit 1 if any `StepResult.success` is false — both compilers, same
place.

## Worth remembering

`tests/cli-cases/` asserts happy paths by default; every tool's FAILURE
contract (exit code on error) deserves its own case. `build-fail` is the
first. The differential's SELF-FAIL/TS-FAIL verdicts only trigger on rc
mismatch — a shared wrong rc (both 0) passes silently, exactly like this bug
did.
