# macOS 26 AppleSystemPolicy Blocks Locally Compiled Binaries

## Status: ENVIRONMENTAL — not a Yo bug. macOS 26 AppleSystemPolicy blocks ad-hoc-signed binaries. Workaround documented in `.github/instructions/testing.instructions.md`: use `--target wasm-wasi` (runs via `wasmtime`) for local testing on affected systems. CI on Linux is unaffected.

## Summary

On macOS 26.x (tested: 26.3.1, Darwin 25.3.0), `AppleSystemPolicy` (ASP) blocks
execution of all locally compiled C binaries that only have an adhoc code signature
(no Apple Developer Certificate).

This affects `./yo-cli test` because the test runner compiles a batch C binary and
tries to run it. The binary hangs indefinitely (never returns) because ASP blocks
it at the kernel level.

## Symptoms

- All compiled test binaries hang immediately (0% CPU, blocked in `_dyld_start`)
- `spctl --assess --type exec binary` returns `rejected`
- System log shows: `kernel: (AppleSystemPolicy) ASP: Security policy would not allow process`
- `yo-cli test` never produces test results — it compiles but the binary doesn't run

## Root Cause

macOS 26 introduced a new mandatory security policy requiring all executables to be
either:

1. Signed with a valid Apple Developer Certificate and notarized, OR
2. Explicitly approved via System Settings → Privacy & Security → Developer Tools

Without this approval, even simple "Hello World" C programs compiled with `clang`
cannot run.

## Workaround (requires GUI)

1. Open System Settings → Privacy & Security
2. Scroll down to "Developer Tools" (or "Security" section)
3. Enable Terminal (or whatever app is spawning the processes)
4. This grants Terminal.app permission to run unsigned locally compiled binaries

## Impact on Tests

All `./yo-cli test` commands are blocked. This means:

- Cannot run `./yo-self/tests/*.test.yo`
- Cannot run `./tests/*.test.yo`
- Cannot run any compiled binary from the test suite

The Yo compiler itself (`./yo-cli`) works fine because it's a Bun/Node.js script.
The TypeScript evaluator works fine (type-checking, codegen to C).
Only the EXECUTION of compiled C binaries is blocked.

## Alternative: WASI/Emscripten

As a workaround, tests can be run via WebAssembly:

```bash
./yo-cli test tests/string/string.test.yo --cc emcc
./yo-cli test yo-self/tests/lexer.test.yo --target wasm-wasi
```

These do NOT require running native ARM64 binaries.

## Previous Passing Tests

The "938/938 ✅" test count in BOOTSTRAPPING.md was achieved in a prior session.
That session likely had Developer Tools approved for Terminal in System Settings,
or ran on a different machine/macOS version (14.x or 15.x).

## Date Found

2026-05-01 (macOS 26.3.1, Darwin 25.3.0)
