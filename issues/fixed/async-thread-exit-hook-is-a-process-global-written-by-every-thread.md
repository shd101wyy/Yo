# The async thread-exit hook is a process global written by every thread (TSan data race)

**Status: FIXED (2026-09-28).** Found from CI on PR #982, where the
`ThreadSanitizer (sync primitives)` job failed. Develop's own battery has
failed the same way since #970.

## Symptom

```
WARNING: ThreadSanitizer: data race
  Write of size 8 ... by thread T2:  __yo_async_enqueue_continuation
  Previous write ... by thread T3:   __yo_async_enqueue_continuation
  Location is global '__yo_async_thread_exit_hook'
```

It was reported in `tests/thread.test.yo`, `thread_pool.test.yo`,
`cross_thread_wake.test.yo` and `spawn_blocking.test.yo`. Reads from
`__yo_cleanup_thread_gc` at thread exit race too.

## Root cause

#970 freed each thread's continuation pool at thread exit through
`__yo_async_thread_exit_hook`, installed by the first continuation a thread
allocates. It was declared as a plain process global, so every thread wrote
it and every exiting thread read it, unsynchronized. That is a data race even
though the stored value is always the same function.

## Fix

The hook is thread-local (`_Thread_local`, or `__declspec(thread)` on Windows;
`src/codegen/functions/declarations.yo`). It frees the exiting thread's own
pool, so a thread that never allocated one keeps NULL and frees nothing.

## Test

The TSan job over `tests/thread.test.yo`, `thread_pool`, `cross_thread_wake`
and `spawn_blocking` (it failed on those four before).
