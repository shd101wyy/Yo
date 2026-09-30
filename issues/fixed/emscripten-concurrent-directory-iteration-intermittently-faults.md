# Under emscripten, "concurrent directory iteration on three threads" intermittently faults (memory access out of bounds)

**Severity:** S1 — an intermittent memory fault in a multi-threaded wasm program: something reads or writes out of bounds

**Status:** fixed (2026-09-30)
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

## Root cause (measured)

`src/codegen/async/runtime_io_wasm.yo` emulates `getdents` with `readdir`.
It keeps one `DIR*` per descriptor across calls, in a linked list, so that a
directory larger than one buffer is not truncated. The list was declared
`static __yo_getdents_stream_t* __yo_getdents_streams`: process-global. Its
macOS twin in `runtime_io_common.yo` is `static _Thread_local`.

Emscripten has pthreads, so three threads iterating directories at once push
onto one list, walk it and unlink from it without a lock. That produces all
three failures seen:

- **Memory access out of bounds:** a thread walks or unlinks a node another
  thread just freed.
- **"expected the 5 files back":** descriptors are process-wide, so a thread
  finds another thread's stream under its own fd and reads the wrong
  directory.
- **"unexpected exception":** an fs call fails on a corrupted stream.

#999 is not involved. With emscripten 6.0.6 (CI's version, local emsdk),
node 24.15, and a clean temp dir before each run, the test's own batch
failed:

| Build | Failures |
| --- | ---: |
| develop before #999 | 11 / 150 |
| with #999's init change spliced into the emitted C | 5 / 150 |
| with the list made `_Thread_local` (spliced) | 0 / 150 |

Among the failures without the fix:

- 8 were out of bounds;
- 4 were "expected the 5 files back";
- 1 was an unexpected exception.

(The first local attempt read 200 / 200: a crashed run had left
`yo_thread_dir_iter_<k>` behind, and every later run then failed at
`create_dir`. So the loop removes those directories between runs.)

## Fix

The WASM list is `_Thread_local`, as the macOS one is: each thread's event
loop owns the `read_dir` streams it opened.
`tests/internal/uring_runtime.test.yo` pins the thread-local declaration in
both the WASM runtime and the macOS common runtime.
`tests/thread.test.yo`'s "concurrent directory iteration on three threads" is
the behavioural test.
