# `timeout` retains its deadline timer after the task wins the race — 256 bytes per call, held for the whole remaining deadline

**Found**: 2026-09-04, by the std-API audit re-measurement of the `std/async`
row. `std/async/index.yo:124-127` already documents this residual and cites
`issues/timeout-deadline-timer-future-leak.md` — this file, which did not
exist (`find . -name 'timeout-deadline-timer-future-leak.md'` returned
nothing, and the only occurrence of the string in the tree was the citation
itself). **Class**: unbounded-until-deadline memory retention on a shipped std
API. **Status**: OPEN.

The module doc's wording is also wrong in a way that matters: it says the
future struct "is never reclaimed". Measured below, it **is** reclaimed — but
only when the deadline finally elapses, and never if the program stops
polling first. The right statement is "retained for the remaining deadline".

## Reproducer

```rust
pragma(Pragma.AllowUnsafe);
open(import("std/fmt"));
{ timeout } :: import("std/async");
{ assert } :: import("std/assert");
{ Duration } :: import("std/time/duration");
{ sleep } :: import("std/sys/timer");
fast :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(sleep(u64(1)), io);
    return(i32(7));
  })
);
main :: (fn(io : Io) -> unit)({
  n := u64(0);
  while(n < u64(800), n = (n + u64(1)), {
    h := io.spawn(fast(io), io);
    r := timeout(h, Duration.from_millis(i64(9000)), io);   // always wins
    assert(match(r, .Some(v) => (v == i32(7)), .None => false), "in-time");
  });
  println("done");
});
export(main);
```

Every call completes in ~1 ms against a 9 s deadline, so the deadline never
fires; the process exits after ~1.2 s. Built with
`yo compile r4.yo --optimize 2 --allocator system -o r4.out` and measured with
`leaks --atExit` (aarch64-apple-darwin, `yo` 0.2.24, tree `std`):

| in-time `timeout` calls | live allocations at exit | bytes |
| --- | --- | --- |
| 0 | 186 | 33 KB |
| 50 | 387 | 46 KB |
| 200 | 987 | 83 KB |
| 800 | 3387 | 233 KB |

Exactly **4 live allocations, 256 bytes, per call**, linear with no ceiling.
`heap` on the 800-call run names them:

```
   COUNT      BYTES       AVG   CLASS_NAME
     800     128000     160.0   calloc in __yo_user_main      ← deadline task state machine
     800      38400      48.0   calloc in yo_id_10595         ← __yo_io_future_t (the timer)
     800      25600      32.0   malloc in __yo_user_main      ← Box(u64) period capture
     800      12800      16.0   malloc in yo_id_10595         ← __yo_timer_ctx_t (kqueue udata)
```

(`yo_id_10595` is the emitted wrapper around `__yo_async_sleep_start`.)

`leaks` does **not** flag these as leaks — they stay reachable from the
state-machine graph — so no leak-checking gate would have caught this.

Change only the deadline to 300 ms and add `io.await(sleep(u64(500)), io);`
after the loop, so every timer gets a chance to fire, and the same 200-call
program ends at **192–193 allocations / 33 KB** — the baseline. That is the proof
that the retention window is the deadline, not the process.

## Root cause

`timeout` (`std/async/index.yo:128-159`) arms a real timer as a spawned task
and, once the awaited handle wins, aborts it:

```rust
ms := Box(u64)(u64(limit.as_millis()));          // :133
deadline_fut := io.async((io : Io) => { io.await(IO_timer.sleep(ms.*), io); return(()); });
dh := io.spawn(deadline_fut, io);                // :138
…
dh.abort();                                      // :156
_deadline_r := dh.await(io);                     // :157
```

`abort()` lowers to `__yo_join_handle_abort_raw`
(`src/codegen/async/runtime_core.yo:369-375`):

```c
static void __yo_join_handle_abort_raw(void* fut) {
  __yo_spawned_future_header_t* h = (__yo_spawned_future_header_t*)fut;
  if (h->state >= 0) { h->state = -2; }
}
```

It flips a state word and nothing else. There is **no cancel path in the I/O
backend at all**: the kqueue `EVFILT_TIMER` armed by `__yo_async_sleep_start`
(`src/codegen/async/runtime_io_common.yo:779-800`) stays registered, and its
`uintptr_t timer_id` — the only handle that could name it in an `EV_DELETE` —
is a local at `:794` that is discarded as soon as the `EV_SET` is issued. The
Linux (`:678-740`, timerfd + io_uring), Windows and wasm
(`src/codegen/async/runtime_io_wasm.yo:693`) backends have no cancel entry
point either, and the abort function above is shared by all of them.

Release therefore happens on exactly one path: the timer eventually fires,
`__yo_io_process_event` (`src/codegen/async/runtime_io_macos.yo:736-742`)
decrements `__yo_pending_io_count` and calls `__yo_io_wake_continuation`,
which queues the aborted task's resume function; the resume function's
externally-aborted entry guard
(`src/codegen/async/state_machine.yo:3486-3512`) sees `sm->state == -2`,
releases the `await_future_N` slots and `__yo_decr_rc((void*)sm)`, and returns
without resuming. Until that moment, all four objects are live.

**This is not specific to `timeout`.** Any `JoinHandle.abort()` on a task
suspended in *any* I/O operation retains that operation's resources until the
operation completes on its own — a read on a socket nobody will write to is
retained for as long as the socket is open. `timeout` is simply the shipped
std API that does it on every single call.

## Fix

Give the runtime a cancel path and use it from `abort`. No workaround: the
correct behaviour is that aborting a task promptly releases what it was
waiting on.

1. **Per-operation cancellation in the backend.** Add `cancel_fn` to
   `__yo_io_future_t` (`src/codegen/async/runtime_io_common.yo`), populated by
   each `*_start` function, plus `__yo_async_io_cancel(future)` that invokes
   it, marks the future terminal and frees the backend-side context. For the
   timer this means storing the kqueue ident in the future (macOS today throws
   it away at `runtime_io_common.yo:794`; Linux already has a
   `__yo_timer_future_t` with a `timerfd` field to hang it on), then
   `EV_SET(&ev, ident, EVFILT_TIMER, EV_DELETE, …)` on macOS,
   disarm + `close(timerfd)` (plus `IORING_OP_ASYNC_CANCEL` for the in-flight
   read) on Linux, `CancelWaitableTimer` on Windows, `clearTimeout` on wasm.
   `__yo_pending_io_count` must be decremented on the cancel path exactly as
   it is on the completion path.
2. **Drive it from abort.** `__yo_join_handle_abort_raw` only sees the spawned
   future's common header, so it cannot reach the state machine's
   `await_future_N` slots. Add a `cancel_pending_fn` to
   `__yo_spawned_future_header_t` (`src/codegen/async/runtime_core.yo:353-356`)
   that codegen fills per async block with a function which cancels whichever
   `await_future_N` slot is live, releases the slots and the state machine —
   i.e. does eagerly what the entry guard at
   `src/codegen/async/state_machine.yo:3495-3512` does lazily. `abort()` then
   becomes prompt and O(1) for every I/O operation, and the entry guard stays
   as the fallback for a completion that was already in flight.
3. **Correct the module doc.** `std/async/index.yo:124-127` should say the
   residual is *retention until the deadline elapses*, not that the struct is
   "never reclaimed" — and, once (1)+(2) land, the note goes away entirely.

Rejected alternative: making `timeout` await a bare `IoFuture` local instead
of spawning a task. That is the shape in
`issues/pending-io-future-local-drop-uaf.md` — the scope-end auto-drop frees a
future the backend still holds — and the comment at `std/async/index.yo:129-132`
records that `timeout` was deliberately redesigned away from it.

## Regression test

The tree has no way to observe allocation counts from Yo (no `rusage`/RSS
helper in `std/`, and `leaks` does not flag these because they stay
reachable), so the numeric claim is pinned by the recorded reproducer and the
table above rather than by an assertion:

- `issues/repros/timeout-deadline-timer-retained.yo` — the 800-call program
  above, with the measurement recipe
  (`yo compile … --optimize 2 --allocator system` then `leaks --atExit -- ./out`).
  Before the fix it ends at 3387 live allocations; after the fix it must end
  at the 186-allocation baseline, unchanged by the loop count.
- `tests/async/combinators.test.yo` gains a behavioural companion next to the
  existing `test("Test timeout completes in time", …)` (`:100`): call
  `timeout` with a long limit (60 s) inside a loop of a few hundred
  iterations, asserting every result. Today that program retains ~256 bytes
  per iteration; with cancellation it is flat. The test asserts correctness
  under repetition — the memory claim rides on the repro.
- Whatever `cancel_pending_fn` is added by fix (2) also needs the general
  case: a task suspended on a `sleep` far in the future, aborted, and the
  program exits immediately — verified through the same repro harness.
