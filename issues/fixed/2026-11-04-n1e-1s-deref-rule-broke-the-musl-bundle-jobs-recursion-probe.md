# N1e-1's `.*` rule broke the static musl bundle job's recursion probe

**Severity:** S3. One develop CI job went red. No compiler behavior was wrong, and no user-facing artifact was affected.

**Status:** fixed 2026-11-04 by `fix/develop-embedded-deref`.

## Symptom

Develop battery run 41823671930 on `c900b3fe6` (#1752, N1e-1) failed "Static musl Linux bundle (build + run, no publish)":

```
##[error]probe failed to compile
error[E0926]: `x` is a reference (`&mut i64`): writing the value it refers to is spelled `x.* = …`
  --> /tmp/tmp.FKgido/probe.yo:3:38
3 | bump :: (fn(x : &mut i64) -> unit)({ x = (x + i64(1)); });
```

## Root cause

`scripts/bootstrap/probe-stack-sizing.sh` writes its probe program from a here-document. The `--migrate deref` sweep covers `.yo` files only. `scripts/check-embedded-yo.sh` is the local net for Yo source embedded in scripts and workflows, but it did not list this probe. #1440 broke the same probe the same way (`issues/fixed/2026-10-18-the-fv-job-runs-generation-a-test-files-with-the-seed.md`), and the probe was not added to the checker at that time either.

## Fix

- The probe now writes `x.* = (x.* + i64(1))`.
- `scripts/check-embedded-yo.sh` gains the probe as site 8, which expects `ok, sum = 125000750000`.
- The test: the checker fails on the old probe with the N1e-1 tree binary (E0926) and passes on the new one.
