# `Thread.join` was re-callable (double `pthread_join`, UB) and un-joined threads leaked

**Status: FIXED** (2026-09-06, `std/thread.yo`, `src/codegen/parallelism/runtime.yo`,
`src/codegen/types/generation.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 4.

## Symptoms

1. `Thread` was a plain value struct holding the raw handle, and `join` called
   `__yo_thread_join` unconditionally. A second `join` — or a `join` on a
   copy of the struct — reached `pthread_join` on an already-joined thread,
   which is undefined behaviour (on Windows: `WaitForSingleObject` on a
   `HANDLE` that `__yo_raw_thread_join` had already closed).
2. Threads are created joinable and nothing ever detached them. A handle that
   went out of scope without `join` leaked the joinable thread's bookkeeping
   for the life of the process (and there was no `Dispose` to hang a fix on:
   a value struct has no drop).

## Fix — Rust's `JoinHandle`

- `Thread` is a `ref(struct(handle, _joined))`. `join` asserts it has not run
  before (`Thread.join: this thread was already joined`), then marks and
  joins. `is_joined()` reads the flag.
- `impl(Thread, Dispose(...))` detaches a handle that was never joined, through
  a new runtime primitive `__yo_thread_detach` (`pthread_detach` / `CloseHandle`;
  a zero handle from the inline-fallback path is skipped, like `join`). The
  thread keeps running and the OS reclaims it when it finishes — exactly
  `JoinHandle::drop`. Reference counting makes the detach run once however
  many copies of the handle exist.
- `__yo_thread_detach` joins the `_is_threading_macro_function` list so no
  `extern` prototype is emitted for it (it is a static runtime-preamble
  function like `__yo_thread_join`).

## Regression tests

- `tests/thread.test.yo` — a helper spawns a thread that sends on a channel and
  lets the handle drop un-joined; the receive proves the detached thread ran.
  `is_joined` before/after `join`.
- `tests/cli-cases/thread-join-twice-panics` — the second `join` panics with
  the message above (`build run`, non-zero rc; a `.test.yo` cannot assert a
  process-killing panic).
