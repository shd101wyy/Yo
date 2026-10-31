# `yo build` defaults its C compiler to `clang` and dies with a bare "file or directory not found" on a box without clang

**Severity:** S2 — on any machine whose PATH has no `clang`, `yo build` (and `yo build test`) fails every C compile with `yo: error: file or directory not found` and no hint that the missing thing is the compiler, so a valid project cannot be built or tested at all.

## What happens

`src/build_runner.yo` resolves the build's C compiler as

```yo
c_compiler := match(
  options.c_compiler,
  .Some(cc) => cc.clone(),
  .None => String.from("clang")
);
```

with NO availability probe — unlike plain `yo compile`, whose default runs
`_find_available_compiler` (clang, cc, gcc, zig — first available;
`src/main.yo`). The value is then forwarded verbatim:

- artifact compiles pass `--cc <c_compiler>` unless it is exactly `"clang"`
  (`build_runner.yo`, `compile_artifact`) — i.e. the default sends NO flag only
  to have `compile`'s own discovery re-pick clang when present, but a test
  suite's child always gets it explicitly;
- `run_test_suite` unconditionally forwards it: `yo test --c-compiler clang …`
  (`build_runner.yo:2419`), and the runner forwards `--c-compiler clang` to
  every batch child compile (`src/main.yo`, `test_cc`).

The batch child then invokes `clang` directly; the spawn fails with ENOENT,
which surfaces as the child's bare `yo: error: file or directory not found`
(the `NotFound` render in `std/sys/errors.yo`), the runner scores the batch
"failed to compile (exit != 0)", and the run reports every test failed. The
ASan-usability probe in the child never runs far enough to matter (its own
leftover `<batch>.asan_probe.c` is what first pointed there). Nothing in the
output names the compiler.

## Repro (WSL box, PATH without clang; `which clang` fails, `/usr/bin/cc` is gcc)

```bash
$ yo build test          # any project with a build.test suite
tests/ok.test.yo
AddressSanitizer is not functional with this compiler setup … Skipping sanitizer.
Using system allocator
Compiling with: clang -std=c11 … -o tests/.yo_selftest_batch_<pid>_1_0.bin …   # with --verbose
yo: error: file or directory not found
yo: error: test: tests/ok.test.yo — 0 of 1 tests in this batch ran: the batch failed to compile (exit != 0).
1 failed
```

The same suite passes with clang on PATH (`nix develop . --command bash -c 'yo
build test'`), and a plain `yo test ./tests/…` (no build runner) passes too,
because the plain runner/compile path discovers `cc`.

## Measured 2026-10-31 (v0.2.73 seed, tree at develop fd206efe7 + D10, branch vbd/b8-d10-r2)

Three cli-diff cases are clang-on-PATH-dependent and go GOLDEN-DIFF in a
clang-less shell (all PASS inside the nix shell, which is the golden/CI
environment):

- `tests/cli-cases/build-test-exclude` — `1 passed` vs `1 failed`
- `tests/cli-cases/build-test-suite-flags` — bail golden vs `3 failed`
- `tests/cli-cases/compile-verbose-prints-cc-line` — golden's `Compiling with:
  clang -std=c11` line vs the discovered `cc` line

So a local cli-diff battery is only comparable to the goldens with clang on
PATH (the repo nix shell), which the harness does not itself enforce.

## Verdict

Pre-existing on develop (the default and the forwarding predate 2026-10; the
TS-era comment at the forwarding site says so). Not caused by D10 (which
touches no build-runner path); filed from the D10 r2 re-gate. Fix belongs in
`build_runner.yo`: default `c_compiler` through `_find_available_compiler`
(the same discovery `compile` uses) instead of the literal `"clang"` — and/or
have the child compile's `--cc` validate availability and name the compiler
in the error. Deferred to a develop fix-forward PR; the test to add with it:
a `build test` suite run with clang masked off PATH succeeds through the
discovered compiler.
