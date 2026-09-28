# Thread-local async runtime arrays (task-abort registry, timer heap) are never freed at thread exit

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit. Tree build of develop `af62bdb28` (LeakSanitizer, Linux).

## Symptom

- `issues/repros/async-shape-x2-task-abort-registry-thread-local-leak.yo`: a 64 B LeakSanitizer
  report whenever a task is unwound by an effect. `__yo_task_abort_register`
  grows `__yo_task_aborts`, and nothing frees it.
- Any program that sleeps reports 128 B, the timer heap grown by
  `__yo_timer_arm` (`src/codegen/async/runtime_io_linux.yo`).

Both are one-time allocations per thread, so this is noise, not growth. It
still shows up in every LSan run of an async test, masking real leaks, and
a program that spawns many threads leaks one of each per thread.

## Root cause

The same class as the continuation-pool leak fixed in #970
(`__yo_async_free_cont_pool`, installed as `__yo_async_thread_exit_hook`):
thread-local arrays with no exit hook.

## Fix direction

Register both frees in the same thread-exit hook chain (the hook is a
single pointer today, so it needs to become a small list, or a single
runtime function that frees every per-thread array). Regression: an LSan
run of the repro that reports zero bytes.

## Fix (2026-09-29)

`__yo_async_free_cont_pool` (`src/codegen/async/runtime_core.yo`), the thread-exit hook, now also runs the idempotent `__yo_io_cleanup` and frees the effect-unwind abort registry. The Linux `__yo_io_cleanup` tears the timer heap down BEFORE its ring-initialised guard, since the heap is userspace-only and exists without a ring. The x2 repro and every test in `tests/async/sm_ownership.test.yo` that sleeps are LeakSanitizer-clean with a stage-1 build.
