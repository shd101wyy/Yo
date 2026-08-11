# Native-Windows build of the self-hosted compiler fails: POSIX-isms in the compiler's own closure

**Status: OPEN** (2026-08-11). Found by the v0.2.0 release's windows-x64 seed
leg (experimental — did not block the seed): the TS compiler emitting
`yo-self/main.yo` FOR Windows produces C that clang rejects. Nothing else
exercises this closure on Windows — the Windows CI job compiles TEST
programs natively (all green), never the compiler itself. The windows test
job now carries a non-gating "native self-hosted compiler build" step for
advance detection; flip it gating when this is fixed.

## Error classes (from the v0.2.0 leg log)

1. `use of undeclared identifier 'F_OK'` — something in yo-self's import
   closure calls POSIX `access()`/`F_OK` without a Windows platform branch.
   Note `std/sys/constants.yo` defines its own `F_OK` — the failing
   reference resolved to the `<unistd.h>` one (module/branch dependent).
2. `call to undeclared function 'setenv'` — POSIX `setenv` reached on a
   Windows target; the guarded pattern (`_putenv_s` behind
   `platform == Platform.Windows`, as in `std/env.yo`) is missing at some
   call site in the closure.
3. `non-void function 'main' should return a value` — the emitted Windows
   `main` wrapper has return-less paths (codegen main-wrapper divergence,
   `src/codegen/functions/generation.ts`).

## Reproduce (macOS/Linux, no Windows box needed)

```bash
./yo-cli compile yo-self/main.yo --target x86_64-windows-msvc --emit-c --skip-c-compiler -o /tmp/yowin
# inspect /tmp/yowin.c for F_OK / setenv / the main wrapper — clang-cl or
# cross-clang with MSVC headers needed for a full compile check; the three
# classes above are grep-able.
```

## Fix shape

Chase each POSIX identifier in the emitted C back to its call site
(evaluator/codegen or std), add the Windows platform branch (or a
`std/sys`-level portable wrapper), and fix the main-wrapper returns in
codegen. Gate: the test.yml windows "native self-hosted compiler build"
step goes green → remove its `continue-on-error` → promote the release
windows-x64 leg to `experimental: false`.
