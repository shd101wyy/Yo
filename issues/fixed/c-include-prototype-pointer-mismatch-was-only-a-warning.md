# A `c_include` prototype's pointer mismatch was a warning on macOS/Linux and an error on windows-11-arm

**Status:** FIXED 2026-09-21. Surfaced by develop's own battery on #820
(run 35573944359): all four `test (windows-11-arm)` shards red, every other
leg green.

## Symptom

```
cross/yo-windows-arm64.c:2569834:122: error: incompatible pointer types passing
'uint64_t *' (aka 'unsigned long long *') to parameter of type
'PPROCESS_MEMORY_COUNTERS' (aka 'struct _PROCESS_MEMORY_COUNTERS *')
[-Wincompatible-pointer-types]
1 error generated.
```

## Root cause

#820 added the macOS and Windows arms of `_current_rss_mb` (src/main.yo):

```rust
task_info : (fn(target_task : u32, flavor : u32, task_info_out : *(u64), task_info_count : *(u32)) -> i32)
K32GetProcessMemoryInfo : (fn(process : ?*void, counters : *(u64), cb : u32) -> i32)
```

Both out parameters are struct pointers in the headers (`task_info_t`,
`PPROCESS_MEMORY_COUNTERS`). Yo emits no prototype of its own for a
`c_include` function — the header's is the only one — so the `*(u64)` the
call passes is an incompatible pointer type at the call site. Two facts let
it reach develop:

1. The C compile step re-enabled `-Wincompatible-pointer-types` as a bare
   `-W` (a WARNING) at -O2 and left `-Wall`'s warning in place at -O0. The
   comment beside it already argued that this diagnostic is never noise; a
   warning is read by nobody, and the local macOS gates (`yo build`, the
   cli-case that FORCES the valve, `gates_fast`) all compiled the arm with
   the warning scrolling past.
2. The windows-11-arm leg installs clang 22, where the diagnostic is an error
   by default. It is the only leg that saw an error, and the local gate has
   no Windows arm.

The macOS `task_info` arm has the identical defect (`integer_t *` in the
header) and compiled with the same warning on every macOS run.

## Fix

- Both bindings take `*void` (C converts `void *` to any object pointer
  implicitly; this is the existing std idiom, `_localtime64_s` in
  std/libc/windows.yo), and the call site casts `(*void)(out_ptr)`.
- The C compile step passes `-Werror=incompatible-pointer-types` at BOTH
  optimization arms, so the mismatch fails the build on the platform the
  developer builds on. A user-written `c_include` prototype that disagrees
  with its header is the same class as a codegen prototype that disagrees
  with its call: the call passes the wrong pointer.

## Gate

`tests/cli-cases/compile-c-include-pointer-type-mismatch`: a fixture binding
`strlen : (fn(s : *i32) -> usize)` and calling it with an `*i32`, compiled
through the real C compiler at -O2. Under the pre-fix binary on macOS it
compiles with a warning at rc=0 (the case scores GOLDEN-DIFF on rc); under
the fixed binary it fails at rc=1 with `compile: C compiler failed (exit 1)`,
which is the kept substring. rc=1 is also what clang 22 already produced, so
the golden is platform-independent.

## Lesson

A diagnostic that "is never noise" must be `-Werror=`; a bare `-W` on a
generated-C build is decorative. And the gate for a new platform arm is a
COMPILE of that arm under the strictest flags, not the run of the feature —
the RSS-valve cli-case exercised the arm at run time on macOS and passed,
because the mismatch only ever changes a compiler verdict.
