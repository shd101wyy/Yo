# The `test` matrix legs fail their seed `yo build` with no diagnostic output

**Status: OPEN** (found 2026-08-15 on PR #126, run 31851051908.)

## Symptom

All four non-Windows legs of the 5-platform `test` matrix failed at
"Stage 1: build the self-hosted compiler with the SEED (`yo build`)", each
producing **exactly one line of output and then an exit code**:

```
2026-08-14T23:39:11Z  Building yo e958b02 → yo-out/x86_64-linux-gnu/bin/yo
2026-08-14T23:54:38Z  ##[error]Process completed with exit code 2.
```

| leg              | duration | exit code |
| ---------------- | -------- | --------- |
| ubuntu-latest    | 15m27s   | 2         |
| ubuntu-24.04-arm | ~15m     | 2         |
| macos-latest     | 28m56s   | 1         |
| macos-26-intel   | ~29m     | 1         |

`windows-latest` failed earlier and separately, at "Install the seed compiler".
The `build-linux-musl-static` job failed the same way at its emit-only step.

## What was ruled out

- **Not a swallowed-stderr bug.** A _successful_ `yo build` prints exactly one
  line ("Building yo <ver> → <path>"). Verified locally: a clean build's whole
  log is that line. So silence is normal here; it is what a killed child looks
  like. A genuine Yo-level compile error _does_ print (verified with a
  deliberate error in a scratch project: prints the diagnostic, exits 1).
- **Not a code defect in this tree.** The identical seed (v0.2.4), tree and
  command reproduce green locally on macOS arm64:
  `YO_MAIN_STACK_MB=4096 nice -n 10 <seed>/bin/yo build --std-path ./std`
  → rc=0 in ~10 min, producing a working 8.8 MB binary
  (`yo check std/assert.yo` → rc=0).
- **Not the `build.yo` allocator option.** Suspected that
  `build.Allocator.Mimalloc` needed build-runner support the v0.2.4 seed
  lacks; checked `git show v0.2.4:std/build.yo` and
  `v0.2.4:yo-self/build_runner.yo` — both already support `allocator`.
- **Not missing liburing.** `test (ubuntu-latest)` _does_ run
  `apt-get install -y liburing-dev` (log line 184).
- **Not a job/step timeout.** GitHub reports a real process exit code, not a
  cancellation.

## Leading hypothesis (NOT yet proven)

Resource exhaustion. Supporting evidence:

- The local repro needed **~10 GB of swap on a 16 GB machine** to finish.
- The repo's own docs put a self-emit at **~9-11.5 GB peak** and state it
  "cannot ride the 7 GB suite runners" (`P2_RETIRE_SRC.md` §2.2).
- Every _other_ self-building job in `test.yml` provisions memory explicitly —
  the hollow sweep has an "Add swap space" step, `bootstrap-stage2` adds a
  32 GB swapfile plus `systemd-run --scope -p MemoryHigh=11G -p MemoryMax=14G`.
  **These `test` legs provision nothing.** That is the regression: P2.5
  step 18/19 moved a full self-build onto the suite runners without the memory
  engineering the rest of the repo already knew was required.
- The Yo→C stage alone emits a **142 MB / 2.26 M-line** C file, which clang
  then compiles at `-O2`.

**The contradiction that keeps this unproven:** the `ThreadSanitizer` and
`hollow sweep` jobs ran the _same_ `yo build` on `ubuntu-latest` in the _same
run_ and passed. Their stage-1 steps are materially identical (the only
difference is `nice -n 10`). If the cause were purely memory, they should be
equally marginal. So either the failure is near enough the edge to be decided
by noise, or something not yet identified differs.

## Next step (landed)

Rather than guess at a fix, the stage-1 step now records the evidence needed to
settle it: pre-build memory/CPU/disk and compiler version, an explicitly
captured exit code, and on failure a post-mortem printing memory state, the
Linux OOM-killer lines from `dmesg`, and the partial `yo-out` tree (which
reveals whether the 142 MB `.c` was emitted before the failure — i.e. whether
it died in the Yo→C stage or in clang).

Once the next run reports, fix precisely:

- if OOM in the Yo→C stage → provision swap on these legs (reuse the proven
  "Add swap space" step) or move the native-build proof off the suite runners;
- if OOM in clang → the same, plus consider `-O1` for the probe build;
- if neither → the post-mortem output will say what it actually was.

**Open design question for whoever fixes it:** these legs need a compiler built
from the PR's own sources (running the language suite under the _seed_ would
test the released compiler, not the change), so "just use the seed" is not a
valid shortcut. The real choice is between provisioning memory on all five
legs on every PR, versus moving the "builds natively on every target" proof to
a smaller, memory-provisioned job and leaving the suite legs cheaper.
