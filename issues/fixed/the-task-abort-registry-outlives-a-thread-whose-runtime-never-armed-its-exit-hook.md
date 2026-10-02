# The task-abort registry outlives a thread whose runtime never armed its exit hook

**Severity:** S3. A 192-byte per-thread array leaks when a task unwinds synchronously on a thread that never armed the async exit hook. It shows under ASan builds, where the state-machine pools are off.

**Status: FIXED (2026-10-01).** This is the long-standing leak behind `tests/async_await.test.yo`'s "Test unwind in async closure", which fails under leak verdicts on the v0.2.46 seed and on develop `29bf728b4`.

## Symptom

```rust
Raise :: (ctl(msg : String) -> i32);
Ctx :: struct(io : Io, raise : Raise);
main :: (fn(io : Io) -> unit)({
  (raise : Raise) = (msg -> unwind(()));
  task := io.async((ctx : Ctx) => ctx.raise(`x`));
  io.await(task, Ctx(io : io, raise : raise));
});
```

With the pools off (`-D__YO_SM_POOLS=0`, the ASan configuration), valgrind reports `192 bytes definitely lost` from `realloc` in `__yo_task_abort_register`.

## Cause

Only the thread-exit hook (`__yo_async_free_cont_pool`) freed the per-thread abort registry's array. The hook runs only if something called `__yo_async_arm_thread_exit()`:
- the continuation pool's first node;
- a backend's `__yo_io_init`;
- a state machine given to its pool.

A task that unwinds on its first synchronous poll with the pools off does none of these. `__yo_task_abort_take_entry` and `__yo_task_abort_report_unobserved` empty the registry, but they never freed its array. The pools-on build was clean only because pooling the machine happened to arm the hook.

## Fix

`__yo_task_abort_registry_free` (`src/codegen/functions/gc_runtime.yo`) releases the array whenever the registry becomes empty: after the last entry is taken, and after the unobserved report. The array now lives exactly as long as it holds entries, and a later `register` reallocs from NULL. The exit hook's free stays valid, since `free(NULL)` is a no-op.

Test: `tests/async_await.test.yo`, "Test unwind in async closure", under leak verdicts. This leak is not observable with a `Dispose` counter.
