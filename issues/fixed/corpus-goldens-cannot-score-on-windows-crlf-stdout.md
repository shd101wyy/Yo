# The codegen corpus cannot score on Windows (compiled programs print CRLF, goldens are LF)

**Severity:** S3 — on a Windows host, `gates_fast.sh` GATE 2 (the
`tests/codegen-bootstrap` corpus) scored 27/156 GOLDEN-DIFF on line endings
alone, so the tier-1 battery was unusable locally and every corpus change had
to wait for the Linux CI run to be judged.

**Status:** FIXED 2026-10-06 (see Fix below). Found 2026-10-06 running
`S1=<tree binary> P=s3b0 bash scripts/bootstrap/gates_fast.sh` on the Windows
box during the develop@`8d6ae6437` merge of `s3/batch-0-fixes`.

## Symptom

```
=== T1 GATE 2: corpus golden scoring ===
FAIL: corpus golden scoring rc=1: PASS 129  GOLDEN-DIFF 27  NO-GOLDEN 0  (total 156)
```

Every diff was `stdout differs from golden`, and the program BEHAVIOR was
identical — `rc_clone_dup` printed `4\r\n3\r\n` where the golden (recorded on
POSIX) says `4\n3\n`, both rc=0.

## Root cause

`scripts/diff-test.sh` captures the compiled program's stdout with a command
substitution and compares it verbatim against the golden. The corpus programs
run under the target's C runtime, and Windows' text mode ends every stdout
line in CRLF; POSIX-recorded goldens end in LF. 27 of the 156 cases print at
least one line; the other 129 print nothing (or a runner summary that carries
no CR), which is why the gate looked platform-clean until a Windows host ran
it.

## Fix

**2026-10-06, branch `s3/batch-0-fixes`** — strip the CRs at CAPTURE
(`body="${body//$'\r'/}"` right after the run), so both scoring and `--record`
are platform-neutral; a Windows record can no longer bake CRLF into a golden
either. A no-op on POSIX, whose captures carry no CR at all. Verified on
Windows with the tree-built binary, no golden re-recorded and none needed:
the GATE 2 command itself went 27 GOLDEN-DIFF → 1, and the one remaining case
is not line endings —

`cond_comptime_arm_match_temp` is platform-dependent BY DESIGN: its program
prints the cache-dir default, and the comptime `(platform == Platform.Windows)`
cond arm is part of the regression surface (the case pins a cond adopting its
inner match's result temp). The POSIX golden says `~/.cache/yo`, Windows
prints `win`. That single golden stays POSIX-recorded and GATE 2 stays a POSIX
gate for that one case; giving `diff-test.sh` per-platform goldens is a
separate design decision, not taken here.
