# Native compile on Windows trusts clang's default triple — x64 LLVM under Windows-on-ARM silently produces x64 binaries

**Status: FIXED** — native Windows compiles pin `--target=<host clang triple>`
explicitly (`run_compile`, `src/main.yo`).

## Symptom

Second `suite-cross-targets.yml` run (32413596987), windows-arm64 native suite
leg: `tests/asm.test.yo`'s batch failed C compilation with

```
tests/.yo_selftest_batch_4_0.bin.c:2752:19: error: unknown token in expression
 2752 |                   "add %0, %1, #5"
<inline asm>:1:18: note: instantiated into assembly here
    1 |         add %eax, %eax, #5
```

The asm **templates** are the aarch64 branches (`mov {0}, #42`,
`add {0}, {1}, #5` — `#` immediates), but the **register substitution** is x86
(`%eax`, `%ecx`): clang compiled the batch for x86_64.

## Root cause

Two facts combine:

1. `run_compile` resolves the compilation target as "`--target` if given, else
   `host_target()`", folds every comptime `platform`/`arch` constant for it —
   but only puts `--target=` on the C compiler command line when the user
   passed one. A **native** compile trusts the C compiler's *default* triple
   to equal the host.
2. On windows-11-arm runners, `choco install llvm` installs an **x86_64 LLVM
   build** that runs transparently under Windows-on-ARM emulation. Its default
   triple is `x86_64-pc-windows-msvc`.

So the (genuinely arm64) suite compiler folded `arch == Aarch64` — selecting
the aarch64 inline-asm branches — then handed the C to a clang that compiled
for x64. Every *other* batch also silently compiled as x64 and passed by
running under emulation; only inline asm makes the skew visible. The same
skew affects any windows-arm64 user with an x64 LLVM installed: `yo compile`
would produce x64 binaries with arm64-folded comptime constants.

This is the same environment fact every CI workflow already compensates for by
hand (release.yml / test.yml / suite-cross-targets.yml all pass an explicit
`--target=` when invoking clang on Windows: "chocolatey's clang default target
is not guaranteed to be this runner's") — but the compiler's own child
invocations had no such pin.

## Fix

In `run_compile`'s C-compiler command construction: when no `--target` was
given and the resolved (host) target is Windows and the compiler is
clang-flavored, pass `--target=${clang_triple(target)}` explicitly. `yo build`
shells out to `self compile --target ...` per artifact, so this one site
covers build, compile, and the test runner's per-batch compiles.

Scoped to Windows deliberately:

- gcc has no `--target` flag, hence the clang guard.
- Blanket always-passing on every OS would break native Alpine builds:
  `detect_linux_abi` is currently a stub returning `Gnu`, so a pinned
  `--target=x86_64-linux-gnu` on a musl host would fight clang's correct
  `-alpine-linux-musl` default. Windows has no such ambiguity (msvc).

## Validation

- macOS: full local `yo test ./tests/asm.test.yo` passes (13/13); the new
  branch is dormant off-Windows.
- End-to-end reproducer: the `suite-cross-targets.yml` windows-arm64 leg —
  re-dispatched after merge.

## History

Surfaced by the same suite run family as
`issues/fixed/test-runner-windows-batch-cleanup-exe-lock.md` (run 1's failure);
run 2 got past that fix and far enough to hit this. windows-x64 passes either
way because the x64 clang default happens to match that host.
