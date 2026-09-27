# The async runtime's continuation pool outlived its thread (a LeakSanitizer report per synchronous await)

**Status:** FIXED 2026-09-28. **Found:** 2026-09-28, while reducing the fast
suite's 549 pre-existing LeakSanitizer failures on Linux (plan
`EVALUATOR_MEMORY_REDUCTION_HANDOVER.md` §3.1).

## Symptom

```rust
{ yield } :: import("std/async");
main :: (fn(io : Io) -> unit)({
  io.await(yield(io), io);
});
```

```
Direct leak of 24 byte(s) in 1 object(s) allocated from:
    __yo_rc_alloc
    __yo_async_enqueue_continuation
    __yo_waker_wake_local
    __yo_async_drain_yields
    __yo_async_run_ready_tasks
    __yo_async_poll_step
    __yo_user_main
```

One such report came from every program, and every test batch, that awaited
synchronously. In `tests/async_await.test.yo` it failed 136 of 215 tests on
their own. Behind it, the real leaks in the same files were impossible to read.

## Root cause

`__yo_async_enqueue_continuation` recycles its nodes through
`__yo_cont_free_list`, a THREAD-LOCAL free list
(`src/codegen/async/runtime_core.yo`). The async-main event loop
(`__yo_async_run_until_complete`) and `__yo_async_wait_all` freed the list
when they finished. A synchronous `io.await` from a plain `main(io)` or a test
body drives `__yo_async_poll_step` instead, and no loop ends there. The last
node stayed in the free list, and when the thread exited the list pointer went
with its TLS: an unreachable block.

`__yo_cleanup_thread_gc` would have been the place, but the lightweight RC
runtime never runs it for the main worker thread.

## Fix

- `__yo_async_free_cont_pool` frees the list. The event-loop exits call it
  instead of their two inline copies.
- The runtime installs it as `__yo_async_thread_exit_hook` (declared in the
  emitted declarations, so the GC runtime can see it) the first time it
  allocates a node.
- The hook runs when the main worker thread's program body returns
  (`__yo_main_thread_entry`), and from `__yo_cleanup_thread_gc` in both
  runtime variants (spawned threads, the full-GC runtime). It is idempotent.

## Measured (Linux, LeakSanitizer on)

| file | develop | fixed |
| --- | --- | --- |
| `tests/async_await.test.yo` | 195 failures of 215 | 59 |
| `tests/async/channel.test.yo` | 9 of 18 | 2 |
| `tests/async/combinators.test.yo` | 30 of 32 | 20 |

The failures left are real leaks, and now they are the ones reported.

## Test

`tests/async_await.test.yo` "a synchronous await leaves no pooled continuation
node behind". The oracle is LeakSanitizer, so it fails locally on Linux without
the fix. CI runs these legs with leak verdicts off, which is why this was
never red there.
