# On emscripten, a thread reaped off the main thread is never reclaimed

**Found:** 2026-09-26, on PR #902's CI (`test-wasm32_emscripten`, emsdk 6.0.6): the new
`tests/cross_thread_wake.test.yo` case "spawn_blocking from a task on a spawned thread, 2000
times" failed on every run with `Aborted(OOM)`.
**Status:** FIXED 2026-09-26. **Class:** runtime resource leak (emscripten only). The v0.2.43
seed has it too; the test that exposed it is new in #902.

## Repro

```rust
{ Thread } :: import("std/thread");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  (i : i32) = i32(0);
  while(runtime(i < i32(20000)), {
    t := Thread(unit).spawn((io : Io) => {
      d := Thread(unit).spawn((dio : Io) => ());
      d.join();
      ()
    });
    t.join();
    i = (i + i32(1));
  });
  println(i);
});
export(main);
```

`yo compile repro.yo --optimize 2 --c-compiler emcc -o repro.js && node repro.js` aborts with
`Aborted(OOM)`, with the v0.2.43 seed and with the tree (local emcc 4.0.12). CI's emsdk 6.0.6 runs
out at 2000 iterations of the spawn_blocking shape. The same loop without the inner thread
(`main` spawns and joins directly) completes 20000 iterations. Natively neither leaks
(`leaks --atExit`: 0 leaks on the tree).

## Cause

The emcc link line for a threaded program was `-pthread -sPTHREAD_POOL_SIZE=4 -sEXIT_RUNTIME=1`,
so `main` ran on the JS main thread. Emscripten finishes a thread's cleanup (its stack, its TLS,
returning its worker to the pool) on the JS main thread, through the JS event loop, when the
thread is joined or detached from another pthread. `main` blocked in `t.join()` never returned
to that loop, so each inner thread (and each `spawn_blocking` worker, which a spawned thread's
loop detaches) stayed allocated. The fixed heap ran out. A thread that `main` itself joins is
reclaimed inside `pthread_join`, which is why the flat loop was fine.

## Fix

Threaded emscripten programs link with `-sPROXY_TO_PTHREAD` (`src/main.yo`). `main` runs on a
pthread and the JS main thread stays free to process cleanup. This is emscripten's documented
configuration for a program whose `main` blocks. The WASI target is unaffected (it takes no
`-pthread`). `plans/reference/WASM_SUPPORT.md` lists the flag.

## Regression tests

- `tests/thread.test.yo`: "Test a spawned thread joins a thread of its own, 5000 times".
- `tests/cross_thread_wake.test.yo`: "spawn_blocking from a task on a spawned thread, 2000 times"
  on the `test-wasm32_emscripten` CI leg, which failed with `Aborted(OOM)` before the fix.
