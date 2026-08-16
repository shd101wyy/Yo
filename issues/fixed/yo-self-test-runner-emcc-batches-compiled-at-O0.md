# yo-self's test runner compiled emcc batches at -O0 — wasm stack overflow on CI's emcc 6 (the PR #127 emcc-leg failure)

**Status: FIXED 2026-08-17.** The `test-wasm32_emscripten` leg failed on
`tests/sys/path.test.yo` "realpath resolves . and .." with:

```
Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 65536)
RuntimeError: memory access out of bounds
```

2492 tests passed before it. The same commit's local run (emcc 4.0.12) was
green — the failure is CI-only (emcc 6).

## Root cause (measured)

TS's test runner compiles emcc batch binaries at `-O2` and everything else at
`-O0` (test-runner.ts:606, `isEmcc ? "-O2" : "-O0"`). yo-self's runner shells
out to `yo-self compile` with no optimization flag — the `-O0` default.

This is load-bearing for the wasm stack: the batch `__yo_user_main` inlines
every test body of the file, and at `-O0` every temporary gets its own stack
slot — LLVM's stack coloring only runs at `-O1`+. One
`MaybeUninit(Array(u8, usize(4096))).new()` materializes as THREE 4 KB locals
(`__yo_uninit_*`, the arg temp, the named local); path.test.yo has six such
buffers, ~72 KB in one frame against emcc's 64 KB default stack.

Both compilers emit the identical triple-local pattern (this is NOT an
emission divergence) — the divergence was the batch compile flags. Measured on
the self-hosted batch C: at `-O0` the binary needs the full 64 KB under
emcc 4 (48 KB fails) and overflows under emcc 6; at `-O2` it runs in 16 KB.

## Fix

`yo-self/main.yo` (run_test batch compile): pass `--optimize 2` to the child
compile when the batch targets emcc (`run_is_wasi || run_is_emcc`) — the
mirror of test-runner.ts:606. (`--optimize` maps to `-O2 -w`, same as TS's
runner args.)

## Why the wasi leg never hit it

The wasi arm already passed `-sSTACK_SIZE=16777216` via `--cflags` (needed for
tests/internal's evaluator frames), which also covers `-O0` frames. The emcc
arm follows TS in not raising the stack — TS never needed to, because its
batches are `-O2`.
