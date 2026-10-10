# The stack-sizing probe kept the deleted `inout` spelling, failing develop's musl leg

**Severity:** S3 (CI only: one required job red on develop; no compiler or user code affected)

## Symptom

develop's battery on `ae78a6178` (V3b step 3, #1302) went red in "Static musl Linux bundle (build + run, no publish)" (run 38040225397). The merge gate failed with it:

```
##[error]probe failed to compile
error: `inout(x)` is spelled `mut(x)`: the `inout` spelling was deleted (plans/VALUES_BY_DEFAULT.md V3b). `yo fix <path> --migrate modes` rewrites it.
```

## Root cause

`scripts/bootstrap/probe-stack-sizing.sh` writes a small Yo program through a heredoc and compiles it with the freshly built musl binary. Neither `yo fix --migrate modes` nor the step-3 sweep reaches a heredoc inside a shell script, and no local gate runs the probe. It only runs in the musl job, so step 3's deletion of `inout(` broke it unnoticed.

## Fix

The probe is written in decision 42's spelling: `bump :: (fn(x : &mut i64) -> unit)` called as `bump(&mut local)`. This compiles with a tree that carries decision 42 Generation A, and keeps compiling after Generation B deletes the mode words. Verified locally with the Generation A build: `YO_MAIN_STACK_MB=1 -> rc=138`, `YO_MAIN_STACK_MB=64 -> rc=0`, `HONOURED`.

## Regression test

The musl job runs the probe on every develop battery. The lesson for later syntax deletions: grep the inline Yo programs too, i.e. `grep -rnE '<deleted form>' scripts .github`. Heredocs and workflow `run:` blocks are outside every `yo fix` sweep.
