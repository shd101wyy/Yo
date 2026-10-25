# `yo build test` without clang on PATH dies with a bare ENOENT that names neither the compiler nor the step

**Severity:** S3: a machine whose PATH has `cc`/`gcc` but no `clang` (this WSL
box outside the repo's nix shell) cannot run `yo build test` at all, and the
failure is a bare `yo: error: file or directory not found` with nothing to say
what was missing. `yo compile` and a plain `yo test` on the same box pick `cc`
and succeed, so the inconsistency reads as a flake, not a missing toolchain.
Workarounds exist (`--cc cc`, install clang, run inside `nix develop`), and CI
plus every macOS dev box have clang, which is why this survived.

**Status:** OPEN — found 2026-10-25 while re-recording the
`tests/cli-cases/init-build-test` golden for the v3-std branch (head
`1f08ba0c8`): the case's `yo build test` failed with "2 failed" and leftover
`tests/.yo_selftest_batch_*_*.bin.asan_probe.c` files, which is what the
golden-diff showed before the environment was understood.

## Repro

```bash
# PATH must have cc but NOT clang (a bare WSL shell qualifies)
mkdir scaffold && cd scaffold && yo init . --name scaffolded
yo build test
```

Verbatim failure (stderr; stdout shows `2 failed` in the Test Summary):

```
AddressSanitizer is not functional with this compiler setup (likely a version mismatch between clang and the ASAN runtime library). Skipping sanitizer. Install a matching ASAN runtime or use --cc with a compatible compiler.
yo: error: file or directory not found
yo: error: test: tests/lib.test.yo — 0 of 1 tests in this batch ran: the batch failed to compile (exit != 0). ...
```

The ASan line is the same ENOENT wearing a second costume: the probe
(`_asan_runtime_is_usable`, `src/main.yo:5332`) spawns the same unfindable
`clang`, treats any probe IO failure as "unusable", and prints its canned
clang-runtime-mismatch text. The misleading order (probe message before the
child's `Using system allocator` banner) is stderr-unbuffered vs
stdout-block-buffered across the child boundary.

## Root cause

- `src/build_runner.yo:3302` resolves the build's C compiler as
  `options.c_compiler` else the literal `"clang"`, with no availability probe —
  unlike plain `yo compile`, whose `_find_available_compiler`
  (`src/main.yo:5048`) probes clang, cc, gcc, zig in order.
- The artifact path knows this and compensates: `compile_artifact`
  (`src/build_runner.yo:1913`) forwards `--cc` ONLY when it is not the default,
  letting the child's own discovery pick a compiler that exists.
- `run_test_suite` (`src/build_runner.yo:2422`) forwards `--c-compiler
  ctx.c_compiler` UNCONDITIONALLY, so the default `"clang"` reaches the test
  child verbatim, the batch compile child spawns `clang`, and the failed spawn
  surfaces as the bare ENOENT — the exact class the comment at
  `src/build_runner.yo:1792` documents for a missing output directory.

## Fix direction

Mirror the artifact path in `run_test_suite`: skip the `--c-compiler` forward
when `ctx.c_compiler` is the unprobed default (or probe once at context build).
The regression test is a cli-case (`yo build test` with a PATH that has cc but
no clang) whose golden — clean pass under `cc`, or an error naming the
compiler — follows from the chosen direction, so it is left to the fix.
