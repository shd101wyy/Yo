# macOS: concurrent async ops on one fd (same direction) orphan the earlier pending op — silent hang

Found during the async I/O runtime audit on macOS (2026-09-13).

## Symptom

Two concurrent async reads on the same pipe/socket read-end: only ONE task
ever completes. The other task's future stays pending forever, and the program
hangs inside the event loop (`__yo_async_poll_step` → `__yo_io_wait` →
`kevent`, forever). There is no error, no panic, and no deadlock report —
`__yo_has_pending_io()` stays true because the orphaned op was counted but can
never be delivered, so the wake-deadlock detector stays silent too.

The same program completes on Linux (io_uring multiplexes every SQE) and on
Windows (IOCP), so this is a macOS-only capability gap that surfaces as a
data-dependent hang.

## Minimal reproducer

```rust
pragma(Pragma.AllowUnsafe);
{ pipe } :: import("std/sys/pipe");
{ setfl } :: import("std/sys/fcntl");
{ O_NONBLOCK } :: import("std/sys/constants");
{ read, write } :: import("std/sys/file");
{ sleep } :: import("std/sys/timer");
{ printf } :: import("std/libc/stdio");
{ GlobalAllocator } :: import("std/allocator");
{ malloc, free } :: GlobalAllocator;

main :: (fn(io : Io) -> i32)({
  (arr : [i32 ; 2]) = [0, 0];
  pipe(&(arr(0)));
  rfd := arr(0);
  wfd := arr(1);
  setfl(rfd, O_NONBLOCK);

  buf_a := (*u8)(malloc(usize(8)).unwrap());
  buf_b := (*u8)(malloc(usize(8)).unwrap());

  task_a := io.async((io : Io) => {
    n := io.await(read(rfd, buf_a, u32(8), u64(0)), io);
    unsafe(printf("task_a read n=%d\n", n));
  });
  task_b := io.async((io : Io) => {
    n := io.await(read(rfd, buf_b, u32(8), u64(0)), io);
    unsafe(printf("task_b read n=%d\n", n));
  });
  ha := io.spawn(task_a, io);
  hb := io.spawn(task_b, io);
  io.await(sleep(20), io);
  msg := (*u8)("hi!\n");
  io.await(write(wfd, msg, u32(4), u64(0)), io);
  ra := ha.await(io);   // <-- never returns
  rb := hb.await(io);
  i32(0)
});
export(main);
```

Observed under `timeout 5 script -q /dev/null ./repro` on macOS:

```
pipe rc=0
setfl rc=0
wrote n=4
task_b read n=4
(exit=124 — killed by timeout; task_a never printed)
```

Sampling the hung process shows the worker thread parked in
`__yo_async_poll_step` → `kevent`.

## Root cause

kqueue maintains **one knote per (ident, filter) pair**. Registering
`EV_ADD | EV_ONESHOT` for the same (fd, `EVFILT_READ`) a second time does not
create a second knote — per `kevent(2)`, "if the event already exists in the
queue, the event is updated", which **replaces the knote's `udata`** with the
second operation's context.

`__yo_io_register_kevent` (src/codegen/async/runtime_io_macos.yo) stored the
per-op `__yo_io_pending_op_t*` directly as the kevent `udata`, so with two
in-flight reads on one fd:

1. task_a's read returns `EAGAIN` → pending op A queued with
   `EV_ADD|EV_ONESHOT, udata = A`; `__yo_pending_io_count++`.
2. task_b's read returns `EAGAIN` → pending op B queued with
   `EV_ADD|EV_ONESHOT, udata = B`; `__yo_pending_io_count++` again.
3. The batched changelist is submitted; B's `EV_ADD` **updates** the knote A
   created — the knote now points at B. There is still exactly one knote.
4. Data arrives: ONE event fires with `udata = B`. B completes; its
   `__yo_pending_io_count--` lands.
5. A is orphaned: nothing in the kernel references it, it can never be
   delivered, and the count is permanently off by one. Awaiting A hangs.

The Linux backend (`runtime_io_linux.yo`) submits an independent SQE per
operation, and the Windows backend queues independent IOCP requests, so both
genuinely multiplex concurrent operations on one descriptor. Only the macOS
backend conflated "one kernel registration" with "one pending operation".

## Fix

Introduce a per-(fd, filter) **registration** object owning a FIFO waiter
list of pending ops (src/codegen/async/runtime_io_macos.yo):

- `__yo_io_registration_t { fd, filter, waiters_head, waiters_tail, next }`,
  per-thread list + free list, mirroring the pending-op free lists.
- The knote's `udata` is the registration, which outlives any single waiter.
  `__yo_io_register_kevent` appends the op to the matching registration's
  waiter list and queues the `EV_ADD | EV_ONESHOT` change only when the
  registration is new. `__yo_pending_io_count` still counts OPS, so the
  loop's liveness math is unchanged.
- `__yo_io_process_event` services the waiter list in order: attempt each
  op's syscall; a would-block (`EAGAIN`/`EWOULDBLOCK`) attempt parks the
  waiter back at the head and stops; a completed attempt pops the waiter,
  wakes its future and frees the pending op, then continues with the next
  waiter.
- If waiters remain after servicing, the one-shot knote was consumed by the
  delivery, so the registration queues a fresh `EV_ADD | EV_ONESHOT` re-arm
  through the deferred changelist. If not, the registration detaches and
  recycles.
- Every error path that used to cancel "the pending op in the changelist"
  (`EV_ERROR` packets, hard `kevent()` failures, `__yo_io_cleanup`) now
  cancels the whole registration's waiter list — the changelist `udata` is a
  registration pointer.

### fd close / descriptor reuse

A registration keyed by (fd, filter) outlives the fd it names only until
somebody closes that fd — after which a *reused* descriptor number would
collide with the stale registration and a new op would silently append to a
registration whose knote the kernel already deleted. The fix therefore also
hooks the runtime's two close entry points (`__yo_async_close_start` and
`__yo_file_close`) with `__yo_kq_drop_fd(fd)`: purge any queued changelist
entries for the fd's registrations, fail every remaining waiter with
`-EBADF` (waking their continuations — strictly better than today, where
those tasks simply never resumed), and recycle the registrations. Closing a
descriptor through a raw libc `close` extern bypasses the hook and leaves the
old undefined behavior (pending op never delivered); std's file handles close
through the hooked paths.

## Verification

- The reproducer above completes after the fix: one read returns 4, the other
  returns 0 (EOF after the write end closes), both handles await, exit 0.
- New regression test: `tests/sys/pipe.test.yo`
  "two concurrent async reads on one pipe end both complete".
- `yo test ./tests/sys/pipe.test.yo --bail -v --parallel 1` green.
