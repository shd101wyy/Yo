# The self-hosted test runner cannot RUN wasm test batches

**Status: OPEN.** Found 2026-08-15 by the converted `test-wasm32_wasi` leg
(run on `e5311bc15`), which is the first time that leg drove the self-hosted
compiler instead of the TypeScript one.

## Symptom

The WASI leg builds stage-1, compiles the batch C successfully, and then:

```
tests/.yo_selftest_batch_1_0.bin.c:12781:1: warning: ...
11 warnings generated.
yo: error: permission denied
```

`permission denied` is an attempt to **execve a `.wasm` file**. A WASI artifact
is not a host executable; it has to run under `wasmtime`.

## The gap

`yo-self` has **no reference to `wasmtime` anywhere**. Its runner execs the
batch binary directly:

```yo
yo-self/main.yo:2052
  tcmd := Command.new(tmp_bin.clone());
```

`src/test-runner.ts` branches instead (`:740-762`, `isWasi`):

```
wasmtime -W max-wasm-stack=16777216
         --dir <dirname(test.filePath)>
         --dir /tmp
         --dir <cwd>
         --env YO_TEST_INDEX=<testIndex>
         <binaryPath>
```

Three details that are load-bearing and easy to lose:

1. **`--env YO_TEST_INDEX=`**, not the process environment. yo-self currently
   sets it with `proc_env.set` (`main.yo:2048`), which a wasmtime guest does
   NOT inherit — every test in a batch would run as index 0.
2. **Three `--dir` grants.** WASI is deny-by-default for the filesystem; the
   test dir, `/tmp` and the cwd all have to be granted explicitly or file I/O
   tests fail in a way that looks like a compiler bug.
3. **`max-wasm-stack=16777216`.** The default guest stack is far smaller than
   what the suite's recursion needs.

The Emscripten side of the same branch needs `node <binary>.js`, mirroring the
`.html` -> `.js` derivation `build_runner.yo` already does for `build run`.

## What is ALREADY ported (do not redo)

The `Pragma.SkipWasm32Wasi` / `SkipWasm32Emscripten` filtering is done —
`main.yo:1682-1735` computes `wasm_target_kind` and skips matching files, with
the same message TS prints.

## Why no earlier run caught it

Both wasm legs drove `node out/cjs/yo-cli.cjs` until 2026-08-15, so they
exercised `src/`'s runner, which has the branch. The gap only becomes reachable
when the legs drive the self-hosted binary — the conversion is what exposed it,
which is the conversion working as intended.

## Fix

Branch at `main.yo:2052` on the resolved test target: `wasmtime` + the flags
above for standalone WASI, `node <bin>.js` for Emscripten, direct exec
otherwise. `is_target_standalone_wasi` and `is_target_wasm` are already
imported there.

## REPRODUCED LOCALLY 2026-08-16 — and the run command is only half of it

Reproduced off-CI with a develop-built stage-1 and nix emcc 4.0.12/wasmtime,
running `test ./tests/short_circuit_str_literal_arg.test.yo --parallel 1`.
Both `--c-compiler emcc` and `--target wasm-wasi` reproduce
`yo: error: permission denied` exactly as CI does.

Inspecting the artifacts (`YO_KEEP_BATCH=1`) turned up a **second, upstream
gap that the run-command fix alone would not have closed**:

```
tests/.yo_selftest_batch_1_0.bin   JavaScript source, ASCII text     <- --target wasm-wasi
tests/.yo_selftest_batch_1_0.wasm  WebAssembly (wasm) binary module
```

**With `--target wasm-wasi` the batch artifact is still JavaScript.** emcc
selects its OUTPUT FORMAT from the output file's extension, and this runner
names every batch `.bin` unconditionally (`main.yo:1938`). So the standalone
`.wasm` a WASI leg needs was never emitted at all — `wasmtime <bin>` would have
been handed JS glue and failed just as informatively as the `execve` did.

TS never hits this because it derives the extension first
(`test-runner.ts:449-456`): `.wasm` for WASI, `.js` for emcc, `.exe` on
Windows. The port dropped that line, and the missing run-command branch is
what made the consequence visible.

### Third defect, found in the same pass: ASan is applied to wasm

The WASI leg selects its compiler with `--target wasm-wasi` and never passes
`--c-compiler`, so `test_cc` is `""` — and both sanitizer gates
(`main.yo:2015`, `:2030`) test only the literal string `test_cc != "emcc"`.
The WASI leg was therefore handing `-fsanitize=address` to emcc and applying a
LeakSanitizer verdict to an artifact carrying no ASan; the local repro drops a
`.bin.lsan_supp.txt` next to the batch, which is the visible tell. TS reads
`isEmcc` off the RESOLVED compiler, not off the flag, so it never diverges.

### Fix as applied

All three, in `run_test`:

1. `run_is_wasi` / `run_is_emcc` resolved once from the existing
   `wasm_target_kind`, plus `batch_ext` (`.wasm` / `.js` / `.bin`) feeding a
   new `batch_base` so the batch name and its siblings stay in one place.
2. The run command branches: `wasmtime -W max-wasm-stack=16777216` with the
   three `--dir` grants and `--env YO_TEST_INDEX=` for WASI, `node <bin>` for
   Emscripten, direct exec otherwise.
3. Both sanitizer gates additionally test `!run_is_wasi`.

Cleanup also removes emcc's sibling `<base>.wasm`, which no existing path
named (TS tracks it as `testWasmPath`, `test-runner.ts:459`).
