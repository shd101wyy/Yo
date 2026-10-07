# windows-11-arm test batches have no aarch64 ASan runtime — the arm64 suite legs still run without AddressSanitizer

**Severity:** S3 — the four `windows-11-arm` shards of `test-native` keep `--disable-sanitize`, so ARM64 CI alone runs the corpus without ASan crash detection (windows-x64, macOS and Linux legs are instrumented)

- **Status**: OPEN (split out of `issues/fixed/windows-images-lost-libasan.md`, whose windows-x64 half was restored 2026-10-03; the compiler-side fix that made the restore possible — the ASan probe consulting the chosen `--c-compiler` — is in and covers ARM64 too, so this is purely a toolchain-availability gap)
- **Found**: 2026-10-03, while restoring ASan on the Windows legs

## Why the arm legs cannot just drop the flag

`test-native` installs LLVM on its Windows legs with `choco install llvm`,
which on `windows-11-arm` is the **x86_64 LLVM build** running under
Windows-on-ARM emulation (`issues/fixed/native-windows-compile-trusts-clang-default-triple.md`).
The compiler pins `--target=aarch64-pc-windows-msvc` on the batch compiles
(the triple fix), so `-fsanitize=address` cross-links and needs
`clang_rt.asan-aarch64.lib` — which the official LLVM win64 distribution
does not ship: its resource dir `lib/clang/<version>/lib/windows/` carries
`*-x86_64` runtimes only (verified 2026-10-03 by listing an official
21.1.8 install: `clang_rt.asan_dynamic-x86_64.{lib,dll}`, no aarch64 file
of any kind). Re-enabling the flag on these legs would fail every batch
link with `unable to find library -lclang_rt.asan-aarch64` (or the
compiler's ASan probe would probe the same driver, get the same failure,
and silently de-instrument — the probe now measures the real toolchain,
so it reports honestly and drops the flag with a warning).

## Restore path

When one of these exists, drop the `windows-arm64` arm of the
`TEST_SAN_FLAG` case in `test-native`'s "Run tests" step
(`.github/workflows/test.yml`):

1. an LLVM win64 distribution (or a choco package) that ships the aarch64
   MSVC-target sanitizer runtimes, or
2. the compiler driving `cl`/`clang-cl` with MSVC's own ARM64 ASan support
   (VS 2022 ships ARM64 ASan runtimes for `/fsanitize=address`) — needs a
   `cl`-flavored driver path in `run_compile` first, or
3. a CI step that builds/fetches `clang_rt.asan-aarch64.lib` into the
   resource dir before the test steps.

The `windows-x64` legs were restored the same day by pointing at the LLVM
clang's x86_64 runtime (`issues/fixed/windows-images-lost-libasan.md`);
until an aarch64 equivalent exists, ARM64 coverage loss is the remaining
harm of the 2026-09-03 runner-image change.
