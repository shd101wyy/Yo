# `yo build` hardcodes `clang` as its default C compiler and fails with a bare "file or directory not found" on hosts without it

**Severity:** S2 — `yo build`, `build test` and `build run` fail every C compile with an undiscoverable error on any host whose PATH has no `clang` (plain Debian/WSL boxes); the workaround (`--c-compiler gcc`) cannot be found from the error text

**Found**: 2026-10-31, gating decision 43 step 3 N2a — the `build-test-exclude`,
`build-test-suite-flags` and `init-build-test` cli-cases GOLDEN-DIFFed locally
("N failed" vs "N passed") while the same cases pass in CI and pass locally with
`clang` on PATH.
**Status**: OPEN.

## Symptom

```
$ yo build test                       # host: WSL2, gcc/cc present, NO clang on PATH
AddressSanitizer is not functional with this compiler setup (likely a version
mismatch between clang and the ASAN runtime library). Skipping sanitizer. …
Using system allocator
yo: error: file or directory not found
yo: error: test: tests/ok.test.yo — 0 of 1 tests in this batch ran: the batch
failed to compile (exit != 0). …
```

The same bare `yo: error: file or directory not found` ends every `yo build`
artifact compile on such a host. `yo compile` and `yo test` on the same files
work, because they pick the C compiler by availability probe.

## Reproducer

Any project whose build has a test suite (e.g. `tests/cli-cases/build-test-exclude/fixture`):

```bash
S=/tmp/bte; rm -rf $S; mkdir -p $S/proj $S/home
cp -r tests/cli-cases/build-test-exclude/fixture/* $S/proj/
cd $S/proj && HOME=$S/home YO_STD=$PWD/std yo build test   # → 1 failed
HOME=$S/home YO_STD=$PWD/std yo build --c-compiler gcc test # → 1 passed
```

`command -v clang` is empty on the failing host; putting nix's clang on PATH
also makes the plain `yo build test` pass (verified 2026-10-31 with the d43-step3
tree binary: `PASS 11 GOLDEN-DIFF 0` over the 11 locally-diffing cases).

## Root cause

`src/build_runner.yo` (~line 3297, `run_build`'s option fold):

```yo
c_compiler := match(
  options.c_compiler,
  .Some(cc) => cc.clone(),
  .None => String.from("clang")
);
```

The build path defaults to the LITERAL `"clang"` and never probes whether it
exists. `run_test_suite` then forwards it (`cmd.arg("--c-compiler");
cmd.arg(ctx.c_compiler.clone())`), and the child's batch compile and every
artifact compile spawn `clang` — `Command.status` throws ENOENT on the missing
executable, which the driver renders as the bare "file or directory not found".
The plain-compile path already does the right thing: `_find_available_compiler`
(`src/main.yo`) tries clang → cc → gcc → zig with a `--version` probe, and the
CLI folds to it when no `--cc` was given.

A second symptom of the same default: the child test run's ASan probe names
"clang" in its skip message and drops the sanitizer even though `cc` links ASan
fine — the probe probes the CONFIGURED compiler (`--c-compiler clang`), which
cannot spawn (cf. `issues/yo-test-asan-probe-leaves-its-probe-c-when-the-cc-spawn-fails.md`,
the probe-c leftover seen in the same sandbox trees).

## Fix

Fold the build default through the availability probe: when `options.c_compiler`
is `.None`, resolve `ctx.c_compiler` with `_find_available_compiler` (exported
from `src/main.yo` or hoisted next to the build's cc helpers) instead of the
`"clang"` literal, so a build on a clang-less host compiles with `cc`/`gcc` as
`yo compile` already does. The fix PR should carry a regression test that pins
the resolution (a PATH-restricted probe: set `PATH` to a dir with `gcc` but no
`clang` inside the test's env, then assert the chosen compiler is `gcc`) — the
cli-cases cannot pin it today because their sandboxes inherit the runner PATH,
and the GitHub images carry `/usr/bin/clang` (which is why CI never saw this).
