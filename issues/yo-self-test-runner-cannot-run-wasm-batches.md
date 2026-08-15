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
