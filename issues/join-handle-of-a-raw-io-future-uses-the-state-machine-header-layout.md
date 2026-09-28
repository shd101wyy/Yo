# A `JoinHandle` of a raw I/O future reads it through the state-machine header layout

**Status: OPEN.** Found 2026-09-29 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`, phase 2), reading the emitted C. Tree build of develop `af62bdb28`.

## The mismatch

`io.spawn` accepts any `Impl(Future(T, E))`, including a raw `IoFuture`
(`issues/repros/join-handle-of-a-raw-io-future-uses-the-state-machine-header-layout.yo`
spawns `unsafe(__yo_async_yield_start())`). Everything that later touches
the handle assumes the STATE-MACHINE prefix.

- `JoinHandle.await` (`generate_join_handle_await`, `src/codegen/exprs/await.yo`)
  casts the future to
  `{ __yo_ref_header_t header; int state; void (*cancel_pending_fn)(void*); T result; void (*continuation_fn)(void*); … }`.
- `__yo_join_handle_abort_raw` (`src/codegen/async/runtime_core.yo`) casts it
  to `__yo_spawned_future_header_t { header; state; cancel_pending_fn; }`.

But `__yo_io_future_t` is laid out
`{ header (8 B); _Atomic int state; int32_t result; _Atomic(void (*)(void*)) continuation_fn; _Atomic(void*) continuation_sm; … }`,
with no `cancel_pending_fn`. So on a raw I/O future:

- the handle's `result` is read at offset 24, which is `continuation_sm`, and
  not at 12, where the operation's `int32_t` result lives. It reads 0 after
  a completion has cleared the waiter, which hides the bug for operations
  whose result is 0 (the yield in the repro), but any byte count or fd is
  lost;
- `abort()` reads `cancel_pending_fn` at offset 16, which is the
  `continuation_fn` slot. If the future has a registered waiter, abort CALLS
  THE WAITER'S RESUME FUNCTION with the I/O future as its state-machine
  pointer.

The repro also leaks the aborted raw future (LeakSanitizer, 48 + 16 + 48 B).

## Fix direction

Phase 2 of the plan: one common future header, a prefix shared by every
future kind (SM, `sync_fut_t`, I/O, yield, park), with the waiter slot and
the abort hook at fixed offsets and `result` after them. `JoinHandle` and
the runtime then read only that prefix. Until then, `io.spawn` of a raw
I/O future must either wrap it in a state machine or be rejected.
