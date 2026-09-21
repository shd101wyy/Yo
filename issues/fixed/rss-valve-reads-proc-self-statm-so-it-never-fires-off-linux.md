# The RSS valve reads `/proc/self/statm`, so it never fires off Linux

**Status:** FIXED 2026-09-21 (branch fix/warm-type-ids-identity-namespace).
Found while un-gating the in-process `yo test` batch loop
(plans/INCREMENTAL_COMPILATION_ZIG_LESSONS.md Phase 4 step 3).

## Symptom

`YO_TEST_IN_PROCESS=1 yo test ./tests/internal --parallel 1` on macOS ran
all 92 files in ONE process: 37:33 wall, **10.2 GB peak**, zero
`exec-restarting the runner` lines — although the RSS valve's default
ceiling is `YO_TEST_MAX_RSS_MB=4096`. Forcing the ceiling to 1 MB on two
trivial test files did not restart either:

```
YO_TEST_IN_PROCESS=1 YO_TEST_MAX_RSS_MB=1 yo test . --parallel 1
2 passed          # no restart line
```

`yo build --watch --max-rss-mb N` and the `profile:` lines' `rss=…MB` read
through the same helper and were equally inert on macOS (every profile line
printed `rss=0MB`).

## Root cause (measured)

`_current_rss_mb` (src/main.yo) read `/proc/self/statm` unconditionally and
swallowed the read error into 0. `/proc` exists only on Linux, so on macOS
and Windows the helper always returned 0 — and 0 is the valve guard's
deliberate "no valve" sentinel (`rss_at_boundary > usize(0)`), so the
`exec-restart` never armed. The valve had only ever been measured on WSL2,
where it works, so the Linux-only read went unnoticed.

## Fix

`_current_rss_mb` dispatches on `platform` at comptime (the std/env.yo
convention — each platform's header reaches only that platform's emitted
C):

- Linux: `/proc/self/statm` field 2 (resident pages), as before.
- macOS: `task_info(mach_task_self_, MACH_TASK_BASIC_INFO)`, `resident_size`
  of the 48-byte `mach_task_basic_info` received in a six-u64 buffer.
- Windows: `K32GetProcessMemoryInfo(GetCurrentProcess(), …)`,
  `WorkingSetSize` of the 72-byte `PROCESS_MEMORY_COUNTERS` (kernel32's own
  `K32` export, no psapi import library).

The bindings live in main.yo, not `std/libc/{darwin,windows}.yo`: `yo build`
compiles `src/` against the SEED's std, so a new std symbol is unusable from
the compiler until a release ships it (the seed gate).

Verified on macOS: the probe reads 1 MB for a hello-world binary whose
`time -l` peak is 1.7 MB, and the 1 MB-ceiling run above prints one
`exec-restarting the runner at file index 1` line and still passes both files.

## Regression test

`tests/cli-cases/test-in-process-rss-valve`: two trivial test files,
`YO_TEST_IN_PROCESS=1 YO_TEST_MAX_RSS_MB=1`; `stdout_keep_match` pins the
restart line's stable part (the resident-MB figure is volatile) and the
`2 passed` summary. Red on macOS/Windows before the fix (no restart line),
green everywhere after.
