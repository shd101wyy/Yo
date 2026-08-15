# The `test` matrix legs fail their seed `yo build` with no diagnostic output

**Status: RESOLVED 2026-08-15** (found on PR #126 run 31851051908; root-caused by the always-on post-mortem in run 31856743929; fixed the same day).

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

## CONFIRMED: memory exhaustion during the Yo->C stage

Run 31856743929, with a background sampler writing to a file and an
`if: always()` post-mortem step (the only shape that survives the step shell
dying — see "The diagnostic that did not work" below):

```
ubuntu-latest, during the build:
  Mem: 15988 total  14912 used   481 free ...  1075 available
  Mem: 15988 total  15372 used   347 free ...   615 available
  Mem: 15988 total  15541 used   242 free ...   447 available   <- plateau, ~4 min
--- OOM killer? ---
(no OOM lines in dmesg)
--- disk ---
/dev/root  145G  58G  87G  41% /
--- partial yo-out tree ---
yo-out/x86_64-linux-gnu/bin        <- EMPTY: no .c was ever written
```

macOS is the same story: `Pages free: 3562` at 16 KB pages is ~57 MB, and
~5 GB free immediately after the process died.

Four conclusions:

1. **It is memory**, not disk (87 GB free) and not a timeout.
2. **The kernel OOM killer never fired.** The process's own allocation failed;
   it was not reaped. That is why the exit codes were the undramatic 2 (Linux)
   and 1 (macOS) rather than 137, which is what sent the first investigation
   looking for a logic error.
3. **It dies inside the Yo->C stage**, before the 142 MB `.c` is written —
   so this is the evaluator/codegen peak, not the clang compile.
4. **Local success was never a contradiction.** The same build passes here on
   16 GB _because ~10 GB of swap is available and gets used_; the runner has
   3 GB. 16+11 fits, 16+3 does not.

The contradiction that kept this unproven is also resolved: ThreadSanitizer and
the hollow sweep passed the same build on the same runner label because the
hollow sweep **adds a 32 GB swapfile**, and tsan simply got lucky at the edge.

## Fix

**Linux: applied.** The `test` legs now add the same 32 GB `/mnt/swapfile` that
`bootstrap-fixpoint` and the hollow sweep already use. That is the regression in
one line: P2.5 step 18 moved a full self-build onto the suite runners without
the memory provisioning every other self-building job in this repo already had.

**macOS/Windows: the self-build is REMOVED from these legs.** `macos-latest`
(arm64) has ~7 GB and there is no `fallocate` equivalent.

Note the macOS evidence was weaker than it first looked: a low `Pages free` is
NORMAL on macOS, where memory sits in inactive/purgeable, so that number alone
did not prove exhaustion the way the Linux numbers did. What settled it was
structural, not numeric:

**Every other heavy self-building job in test.yml is `ubuntu-latest`** —
`bootstrap-fixpoint`, `bootstrap-fixpoint-stage3`, `bootstrap-self-test`,
`compiler-internal-tests-selfhosted`, `build-linux-musl-static`, `test-tsan`
and `hollow-sweep`. The `test` matrix was the ONLY job attempting a self-build
on macOS/Windows, and the only one failing. Linux-only restores the
architecture this repo already had; it does not invent a carve-out.

On macOS/Windows the suite now runs under the SEED with `YO_STD` pointed at the
checkout.

**`YO_STD` is load-bearing there, and its absence would have been silent.** std
resolution is `--std-path` -> `YO_STD` -> a walk-up from the executable ->
`./std`. A stage-1 binary sits at `yo-out/<triple>/bin/yo`, so its walk-up lands
on the checkout's std for free; the seed sits at `$RUNNER_TEMP/yo-seed/bin/yo`,
so its walk-up finds the SEED's OWN bundled std. Without `YO_STD` these legs
would have tested the RELEASED std while reporting that they tested the PR's.
Verified red-first against the real v0.2.4 seed: a bogus `YO_STD` fails on
`/nonexistent/std/prelude.yo`, the correct one passes.

## Coverage cost, stated plainly

macOS/Windows legs now cover std changes and platform-specific runtime/codegen
behaviour, but NOT a PR's own compiler changes on those platforms. Those are
proven at release time by `release.yml`'s `seed-bundles`, which builds natively
on all five targets.

Restoring per-PR macOS compiler coverage needs one of:

- bringing the emit's peak memory down — `plans/backlog/YO_SELF_ENV_SHARING.md`
  identifies the root cause (def-time body envs COPY what TS SHARES, 7.4 M live
  `Variable`s); or
- paid larger runners (`macos-*-xlarge`), which is a spend decision, not a code
  one.

This coverage was ALREADY destined to be lost to `src/` retirement: before P2.5
step 18 these legs tested the PR's _TypeScript_ compiler, which Group E
deletes. Once `src/` is gone there is no way to test a PR's compiler on macOS
without building it there.

## The diagnostic that did not work (worth remembering)

The first attempt put the post-mortem _inside_ the same step, after
`yo build`. It never ran: the step shell dies together with the build, so the
log jumped straight from "Building yo" to the runner's own "exit code 2" with
none of the echoes. Anything that must survive a step's death has to be a
separate `if: always()` step reading a file written by a background sampler.

## Original hypothesis (kept for the record)

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
