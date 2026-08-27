# Binding a pending IoFuture to a local: scope-end auto-drop frees what the backend still holds

**Found**: 2026-08-27 by analysis while designing `std/async`'s `timeout()`
(STD_API_AUDIT §7 P0 item 6). **Status**: OPEN — analysis-verified hazard, not
yet observed as a crash (ASan is non-functional on the dev box); nothing in
std or the corpus binds an unfired `IoFuture` to a local any more (`timeout()`
was redesigned to use a spawned deadline TASK instead).

## The shape

```rust
IO_timer :: import("std/sys/timer");
probe :: (fn(io : Io) -> bool)({
  deadline := IO_timer.sleep(u64(5)); // armed in the backend immediately
  s := io.state(deadline);            // fine — non-blocking read
  s == FutureState.Completed
});                                    // <-- scope end
```

At scope end codegen emits `if (deadline != NULL) { __yo_decr_rc((void*)
deadline); }` for the local. `__yo_async_sleep_start` created the future with
refcount 1 and ALSO handed a borrow to the I/O backend (the kqueue timer ctx
holds `ctx->future`; epoll/iocp equivalents likewise). The drop takes rc to 0
and frees the struct while the timer is still armed; when it fires, the
completion handler writes `ctx->future->result` and reads fields in
`__yo_io_wake_continuation` — use-after-free.

The normal async pathway never hits this: an awaited io future lives in the
state machine's `await_future_N` slot and is released only AFTER completion
(extraction or the aborted-entry guard), when the backend is done with it.

## History / masking

Until 2026-08-27 this shape did not even compile: the local was DECLARED as
the bare `__yo_io_future_t` struct by value (see
`issues/fixed/io-future-named-local-declared-by-value.md`), so `->state` and
the drop's `(void*)` cast were C errors. Fixing the declaration made the drop
compile — and made this ownership hole reachable.

## Fix directions (pick one)

1. **Suppress the auto-drop for io-future-typed locals** — ownership of an
   extern io future is the await machinery's / backend's, never the binding's.
   Cheap, matches the TS-era behavior of never dropping these, leaks only a
   never-awaited future (bounded, same class as
   `issues/spawn-closure-captures-never-dropped-leak.md`).
2. **Backend cancellation API** — a real `__yo_io_cancel(fut)` that disarms
   the pending op and releases the borrow, letting the drop stand. Correct but
   per-backend work (kqueue EV_DELETE, epoll timerfd close, IOCP CancelIoEx).

Option 1 is the honest minimum; option 2 is what a future `Drop`-correct
IoFuture story needs.
