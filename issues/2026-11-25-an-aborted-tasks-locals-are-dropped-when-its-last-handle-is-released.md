# An aborted task's locals are dropped when its last handle is released

**Severity:** S2 — `JoinHandle.abort()` (or an enclosing `select`/`timeout`) leaves an aborted task's locals alive until the task's last handle is released: a local's `Drop` runs late, and a task that is a `select` or `timeout` keeps running its operands after the abort (six more ticks in the reproducer), on every backend.

- Filed: 2026-11-25 (lane abort-walk, VERDICTS-83 probes `p3` and `p6`; the cause under `issues/2026-11-25-aborting-a-task-that-awaits-timeout-or-select-returns-its-join-while-the-operands-read-is-in-flight.md`).
- Status: open. Known open in v0.2.80; the fix is VERDICTS-83 §3 (the abort walk), the first v0.2.81 PR.

## Reproducers

Both are safe code. `p3`: when is an aborted task's `Drop` local dropped?

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
{ sleep } :: import("std/sys/timer");

Loud :: struct(id : i32);
impl(
  Loud,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      println(`  drop Loud ${self.id}`);
    })
  )
);

_task :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    l := Loud(id : i32(1));
    e.await(sleep(u64(10000)), e);
    l.id
  })
);

main :: (fn(io : Io) -> unit)({
  h := io.spawn(_task(io), io);
  io.await(yield(io), io);
  println("abort");
  h.abort();
  println("after abort");
  io.await(yield(io), io);
  io.await(yield(io), io);
  println("two loop turns later, handle still held");
  r := h.await(io);
  println("after the join consumed the handle");
});
export(main);
```

```text
$ ./p3                          # develop 0d862baec (#2077); io_uring and epoll alike
abort
after abort
two loop turns later, handle still held
  drop Loud 1
after the join consumed the handle
```

Expected: `drop Loud 1` between `abort` and `after abort`.

`p6`: abort a task that is a `select`, keep its handle. Do the operands stop?

```yo
{ println } :: import("std/fmt");
{ select } :: import("std/async");
{ sleep } :: import("std/sys/timer");

_ticker :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    (mut(i) : i32) = i32(0);
    while(i < i32(12), i = (i + i32(1)), {
      e.await(sleep(u64(2)), e);
      println(`  tick ${i}`);
    });
    i
  })
);
_nap :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    e.await(sleep(u64(10000)), e);
    i32(0)
  })
);

main :: (fn(io : Io) -> unit)({
  h := io.spawn(select(_ticker(io), _nap(io), io), io);
  io.await(sleep(u64(5)), io);
  println("abort the select task");
  h.abort();
  io.await(sleep(u64(12)), io);
  println("12 ms later, handle still held");
  _r := h.await(io);
  io.await(sleep(u64(8)), io);
  println("after the join consumed the handle");
});
export(main);
```

```text
$ ./p6                          # io_uring and epoll alike
  tick 0
  tick 1
abort the select task
  tick 2
  tick 3
  tick 4
  tick 5
  tick 6
  tick 7
12 ms later, handle still held
after the join consumed the handle
```

Expected: no tick after `abort the select task`.

## Root cause

An abort does not drop the task's frame. `JoinHandle.abort()` runs the task's abort hook (`<block>_cancel_pending`, `src/codegen/async/state-machine.yo`), which aborts what the task is suspended in (its await slot), marks the task `-2` and wakes its waiters. The task's live locals are dropped only by `<block>_state_dispose` (`src/codegen/exprs/async.yo`, `generate_async_block_state_dispose_function`), which `__yo_decr_rc` runs when the state machine's count reaches zero, that is, when the last `JoinHandle` (or the awaiter's reference) is released. In `p3` the handle is held until `h.await(io)` consumes it, so `Loud`'s `Drop` runs there. In `p6` the `select` task's `_Scoped` locals, whose `Drop` aborts the operands, are dropped at the same late point, so `_ticker` keeps running for the whole time the handle is held.

On io_uring and IOCP the same lateness is a write into freed memory: the operand's read outlives the abort's observer (the S1 linked above).

## Fix

VERDICTS-83 §3: once an aborted task's await slot has retired, the task drops its live locals, newest first, before it wakes its waiters; a drop that aborts a future which cannot retire at once makes the task linger (`-4`) and continue the walk when that future retires. Tests: `p3` and `p6` as ordering tests in `tests/sys/pipe.test.yo` or `tests/sys/socketpair.test.yo`, failing before the fix.
