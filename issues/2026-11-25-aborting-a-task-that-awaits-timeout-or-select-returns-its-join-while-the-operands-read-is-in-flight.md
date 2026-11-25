# Aborting a task that awaits `timeout` or `select` returns its join while the operand's read is in flight

**Severity:** S1 — on io_uring, aborting a task suspended in `select(stream.read(&mut buf, io), …)` or `timeout(…)` lets `JoinHandle.await` return while the scoped operand's read is still queued in the kernel, which then writes into `buf` after the caller has taken it back (or freed it).

- Filed: 2026-11-25 (lane q6-abort-uring, v0.2.80; the case `fix/abort-inflight-frame-linger` does not cover).
- Status: open.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
{ printf } :: import("std/libc/stdio");
{ write, read } :: import("std/libc/unistd");
pipe_io :: import("std/sys/pipe");
file :: import("std/sys/file");
fcntl :: import("std/sys/fcntl");
{ O_NONBLOCK } :: import("std/sys/constants");
{ yield, select } :: import("std/async");
{ sleep } :: import("std/sys/timer");

_read_into :: (fn(fd : i32, buf : *u8, io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => e.await(file.read(fd, buf, u32(256), u64.MAX), e))
);
_nap :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    e.await(sleep(u64(1000)), e);
    i32(0)
  })
);
_holder :: (fn(fd : i32, buf : *u8, io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => match(e.await(select(_read_into(fd, buf, e), _nap(e), e), e), .Some(_) => i32(1), .None => i32(0)))
);

main :: (fn(io : Io) -> unit)({
  mut(fds_uninit) := MaybeUninit(Array(i32, usize(2))).new();
  fds := (*i32)(fds_uninit.as_ptr());
  assert(pipe_io.pipe(fds) == i32(0), "pipe");
  rfd := fds.*;
  wfd := (fds.add(usize(1))).*;
  assert(fcntl.setfl(rfd, fcntl.getfl(rfd) | O_NONBLOCK) == i32(0), "nonblocking");
  mut(b_uninit) := MaybeUninit(Array(u8, usize(256))).new();
  b := (*u8)(b_uninit.as_ptr());
  mut(d_uninit) := MaybeUninit(Array(u8, usize(4096))).new();
  (mut(bad) : i32) = i32(0);
  (mut(k) : i32) = i32(0);
  while(k < i32(200), k = (k + i32(1)), {
    unsafe(write(int(wfd), (*void)((*u8)("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")), usize(32)));
    h := io.spawn(_holder(rfd, b, io), io);
    h.abort();
    _hr := h.await(io);
    // The aborted holder was joined: the buffer is ours again.
    (mut(i) : usize) = usize(0);
    while(i < usize(256), i = (i + usize(1)), {
      (b.add(i)).* = u8(66);
    });
    io.await(yield(io), io);
    io.await(yield(io), io);
    (mut(j) : usize) = usize(0);
    while(j < usize(256), j = (j + usize(1)), {
      if((b.add(j)).* != u8(66), {
        bad = (bad + i32(1));
      });
    });
    _d := unsafe(read(int(rfd), (*void)((*u8)(d_uninit.as_ptr())), usize(4096)));
  });
  unsafe(printf("bytes overwritten after the join returned: %d\n", bad));
});
export(main);
```

```text
$ YO_IO_BACKEND=uring ./repro     # develop 1ce232268, and with fix/abort-inflight-frame-linger
bytes overwritten after the join returned: 6400
$ YO_IO_BACKEND=epoll ./repro
bytes overwritten after the join returned: 0
```

When `select` itself aborts the losing operand, the buffer is safe once `select` returns. That case is fixed by `fix/abort-inflight-frame-linger` and pinned in `tests/sys/pipe.test.yo`. This issue is the abort of the task AROUND the combinator.

## Root cause

`select` and `timeout` run each operand as a scoped child task (`_Scoped`, `std/async/index.yo`) and suspend on a join wait, a park future. Aborting the holder aborts what it awaits: the combinator's state machine, whose await slot is that park. A park cancels synchronously, so the combinator and the holder retire at once (`__yo_future_abort` answers true), and `h.await(io)` returns. The operands are not in the await chain. They are aborted only when the combinator's state machine is disposed (`_Scoped`'s `Drop`), which happens when the holder's aborted-entry guard releases it, a queue turn later. Nothing waits for them to retire. The operand's READ, queued in the SQ, is submitted at the next enter and completes into `buf`. On epoll the operand's cancel is synchronous and the read happens only after readiness, so nothing is written.

`_Scoped`'s documentation promised "the task that runs one must never outlive the combinator's own future". On this path the operand's operation outlives it.

## Recommendation

The abort of a combinator must abort its scoped operands during the abort, and the combinator must linger until each one retires. Two shapes:

1. **A scoped wait.** `timeout` and `select` suspend on a wait that records their scoped operands. Its cancel hook aborts each operand. If any answers that it lingers (`__yo_future_abort` returns false), the wait stays pending and completes only when every aborted operand has retired. The combinator then reads `-4` like any task whose operation is in flight, and the guard chain releases it and the holder in order. This is new runtime surface (an extern in `std/sys/externs.yo`), so the seed must carry it before std can use it.
2. **Wait for VERDICTS-81 (AFA).** There, scoped children live inside the parent task's block, and the header count keeps the whole block alive until its last in-flight operation retires.

(1) fixes v0.2.80-era programs. (2) is where the design is going anyway.
