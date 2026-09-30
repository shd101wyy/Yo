# Under emscripten, "concurrent directory iteration on three threads" intermittently faults (memory access out of bounds)

**Severity:** S1 — an intermittent memory fault in a multi-threaded wasm program: something reads or writes out of bounds

**Status:** open
**Found:** 2026-09-30, in CI for PR #999.

## Symptom

`tests/thread.test.yo`, test "concurrent directory iteration on three
threads", in the `test-wasm32_emscripten` job (emscripten 6.0.6, node 24):

```
  ✗ concurrent directory iteration on three threads
    Test failed with exit code 256
    RuntimeError: memory access out of bounds
        at wasm://wasm/000a6f92:wasm-function[259]:0x17df9
        ...
        at invokeEntryPoint (.../tests/.yo_selftest_batch_249_0.js:1:13899)
```

The test spawns three `Thread`s. Each creates a directory, writes 5 files
and reads the directory back 40 times, then the main thread joins all three.

## What is measured

- Run 36631825345 (PR #999 head `3a551ed12`), job 109632990217: failed as
  above. 4,087 other tests in the job passed.
- The same job re-run on the same commit passed.
- PRs #1005, #1007 and #1019, on the same develop base, passed it.
- It does not reproduce locally. The local emscripten (4.0.12, nix) fails
  every thread test in the file, with or without #999, so it cannot show this
  one.

## What is not known

Whether #999 is involved. Its WASM-side change makes `__yo_io_init` arm the
thread-exit hook. So a worker thread that only did synchronous I/O now runs
`__yo_async_free_cont_pool` → `__yo_io_cleanup` at exit, where before it ran
nothing. Everything that path frees is `_Thread_local` (the continuation
pool, the task-abort registry, the wasm timer list, `__yo_io_initialized`).
It runs from both the thread entry's explicit `__yo_cleanup_thread_gc()` and
the pthread key destructor, and both are idempotent. That rules out one
thread freeing another's state, but not a teardown-order problem under
emscripten's pthreads. A pre-existing race in the threaded fs path is equally
possible: one failure in several runs cannot tell the two apart.

## Next step

Loop this one test under CI's emscripten (a temporary workflow on a branch,
or a local emsdk 6.0.6) with and without #999's init change, and build with
`-sASSERTIONS` and a debug build for a symbolized stack.
