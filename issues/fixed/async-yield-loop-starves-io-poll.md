# A task that re-enqueues itself on every resume (a loop awaiting `yield`) starves the I/O poll — timers and sockets never complete

**Found**: 2026-08-28 (C33: `fetch_with`'s deadline race spun forever; the
`fetch throws Timeout` test hung). **Status**: FIXED —
`src/codegen/async/runtime_core.yo`, `__yo_async_run_ready_tasks`.

## Symptom

```rust
h := e.io.spawn(work(e.io), e);
dh := e.io.spawn(sleep(limit, e.io), e.io);
while(runtime(!(h.is_finished()) && !(dh.is_finished())), {
  e.io.await(yield(e.io), e.io);
});
```

never exits. `--debug-async-await` shows the same state machine resuming
forever — `Re-evaluating while loop condition` → `Spawning task` → `Queue
count: 1` → resume — with no `[Io] Polled …` line in between: the 100 ms timer
behind `dh` and the peer socket behind `h` are never polled.

## Mechanism

`__yo_async_poll_step` is "drain the ready queue, then poll I/O":

```c
static void __yo_async_run_ready_tasks(void) {
  while (__yo_thread_async_queue.head) { … cont->resume_fn(sm); … }
}
static void __yo_async_poll_step(void) {
  __yo_async_run_ready_tasks();
  if (__yo_io_initialized) { __yo_io_poll(); … }
}
```

`yield` is an immediately-completing future, so awaiting it re-enqueues the
awaiting task *during* the drain; the drain loop picks it up again, and the
queue is never empty, so `__yo_io_poll()` is never reached. Every completion
that would end the loop lives behind that poll. `__yo_async_run_until_complete`
(the async-`main` loop) already caps its inner drain at 100 tasks per
iteration; the poll step used from synchronous awaits, `JoinHandle.await` and
the `std/async` combinators did not.

## Fix

`__yo_async_run_ready_tasks` runs only the tasks queued at entry
(`budget = queue.count`); continuations enqueued during the step run in the
next step, after one I/O poll. Fairness between tasks is unchanged (a task
still runs at most once per step); what changes is that I/O is polled at least
once per step even when some task is always ready.

## Repro

`tests/http/http.test.yo` "fetch throws Timeout when the server never answers"
(hung before, passes after), and any `yield`-driven poll loop against a timer.
