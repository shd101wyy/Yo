# Windows runner images lost libasan — every ASan-instrumented test link fails with "cannot find -lasan"

**Severity:** S3 — Windows CI legs run the whole corpus without ASan (`--disable-sanitize`) — memory-safety detection lost until the images ship libasan again

- **Status**: FIXED (2026-10-03, branch `s3/batch-0-fixes`) — see
  ["Fixed"](#fixed) below. The windows-x64 legs run ASan again through the
  LLVM clang; the four `windows-11-arm` shards remain without it and are
  tracked separately in
  [`issues/windows-11-arm-test-batches-have-no-aarch64-asan-runtime.md`](../windows-11-arm-test-batches-have-no-aarch64-asan-runtime.md).
- **Found**: 2026-09-03, PR #396's CI — both `test (windows-latest)` and
  `test (windows-11-arm)` failed every batch link with

```
C:/mingw64/bin/../lib/gcc/x86_64-w64-mingw32/15.2.0/.../ld.exe: cannot find -lasan: No such file or directory
collect2.exe: error: ld returned 1 exit status
```

- **Not PR-specific**: the failure is uniform across every test file and
  reproduced identically on a `--failed` rerun, while develop's windows legs
  (run 33704787725, finished minutes earlier) were green — the runner image
  rolled mid-day and the mingw64 toolchain no longer carries the ASan
  runtime. `--c-compiler clang` on these images resolves through the mingw64
  driver, whose `--sanitize address` links `-lasan`.

## Restore path

When the images (or a choco/msys2 install step in the workflow) provide
libasan again, drop the two `TEST_SAN_FLAG` conditionals in
`.github/workflows/test.yml` (the `test` job's "Run tests" step and the
`test-native` job's). Until then Windows loses ASan crash detection for the
language corpus — macOS/Linux coverage is unchanged.

## Fixed

Restored 2026-10-03 on branch `s3/batch-0-fixes`, by a different route than
"the images ship libasan again": the windows-x64 legs no longer touch a
toolchain that would need it. Two findings drove the fix. First, the
restore was blocked COMPILER-side all along: `_asan_runtime_is_usable`
(`src/main.yo`) probed the hardcoded system `cc` while the batches linked
through the `--c-compiler clang` driver — on any box whose `cc` is absent or
ASan-broken the probe silently dropped `-fsanitize=address` for a perfectly
capable clang (reproduced locally: `yo compile --sanitize address
--c-compiler clang` printed "AddressSanitizer is not functional … Skipping
sanitizer" and emitted an uninstrumented binary). The probe now compiles and
runs its trivial program with the CHOSEN driver, and on Windows it also puts
the driver's ASan runtime DLL directory (`<llvm>/lib/clang/<v>/lib/windows`,
found via `where.exe`, the same discovery the test runner already uses for
its batch children) on the probe-run's PATH — the DLL is not on PATH by
default, and the child compile that owns the probe is spawned before the
runner's own PATH edit. (That discovery had in fact NEVER worked: its path
template put a backslash before an interpolation, which a Yo template does
not interpolate — it built a literal `${vname}` into the path and returned
`.None` everywhere, masked before 2026-09-03 by mingw's runtime sitting on
PATH. Fixed with it; the trap itself is
[`issues/backslash-then-interpolation-in-a-template-is-not-interpolated.md`](../backslash-then-interpolation-in-a-template-is-not-interpolated.md).)
Second, the CI route: `test-native` already installs
the choco LLVM clang and puts it first on PATH, and that clang's
x86_64-pc-windows-msvc ASan runtime ships INSIDE the LLVM distribution
(`clang_rt.asan_dynamic-x86_64.lib`/`.dll` — no `-lasan` anywhere), so with
the probe measuring the real driver the flag simply works. The workflow's
`test` job (Linux-only since the self-build left the matrix) dropped its
dead `TEST_SAN_FLAG` conditional; `test-native` keys the remaining
`--disable-sanitize` on `matrix.target == windows-arm64` only — choco's LLVM
there is the x86_64 build under WoA emulation and its resource dir ships no
`clang_rt.asan-aarch64` (verified by listing an official 21.1.8
distribution), which is
[`issues/windows-11-arm-test-batches-have-no-aarch64-asan-runtime.md`](../windows-11-arm-test-batches-have-no-aarch64-asan-runtime.md).
Test: `tests/internal/compile.test.yo` pins the probe-to-chosen-compiler
wiring (a fake cc named `clang` on PATH must see the probe's
`-fsanitize=address` invocation and then the un-sanitized driver invocation
after its own probe run fails) — it failed against the pre-fix compiler and
passes after. `run_compile` is now exported from `src/main.yo` for that
test. Watch item for the first battery with this change: the unsharded
`test (windows-latest)` leg re-arms ASan and its 120-min cap was calibrated
(2026-09-16) on post-disable timings of 54–58 min; if the leg pushes the
cap, raise it in the same move as the investigation.
