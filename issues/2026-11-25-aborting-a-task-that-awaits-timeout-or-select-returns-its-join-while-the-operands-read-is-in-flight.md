# Aborting a task that awaits `timeout` or `select` returns its join while the operand's read is in flight

**Severity:** S1 — on io_uring (and, by reading, IOCP), aborting a task suspended in `select` or `timeout`, by `JoinHandle.abort()` or as the losing operand of an enclosing `select`/`timeout`, lets the abort be observed while a scoped operand's read is still queued in the kernel, which then writes into a buffer the caller has taken back or freed; safe code reaches it with no `abort` call.

- Filed: 2026-11-25 (lane q6-abort-uring, v0.2.80; the case `fix/abort-inflight-frame-linger` does not cover).
- Amended: 2026-11-25 by VERDICTS-83 (the safe reproducer, the join window, the reach, the design).
- Status: open. Known open in v0.2.80; the fix is VERDICTS-83 §3, the first v0.2.81 PR. `YO_IO_BACKEND=epoll` avoids it.

## Reach

Safe code reaches it on Linux's default backend: `auto` picks io_uring first and falls back to epoll only when the ring cannot be created (`src/codegen/async/runtime-io-linux.yo`). It needs three things:

- **The backend:** io_uring (reproduced) or IOCP. IOCP is by reading, not reproduced: since #2077 `__yo_win_sock_cancel` issues `CancelIoEx` and answers false, so an aborted socket operand lingers exactly like a ring read, and nothing above it waits. epoll and kqueue cancel synchronously and transfer only after readiness, so no byte is written (but see `issues/2026-11-25-an-aborted-tasks-locals-are-dropped-when-its-last-handle-is-released.md`: the operands keep running).
- **An operand that writes into memory borrowed from above the combinator:** a `BufReader`, a `&mut` buffer. Operands that own their buffer (`recv_bytes`) linger by themselves and are safe.
- **An abort of the task around the combinator while that operation is still queued or cannot be taken back:** `JoinHandle.abort()` or, more commonly, an enclosing `select` or `timeout` (`select(timeout(read…), shutdown)`, `timeout(fetch(…))`). A poll-armed socket read that was already submitted is safe in practice under `DEFER_TASKRUN`.

Uncommon and timing-dependent, but natural code.

## Reproducers

### Safe code, no `abort` call (VERDICTS-83 `p1`)

`select(timeout(read_line), ready)`: `ready` wins in the tick the line read was queued, `select` aborts the `timeout` task, which retires at once; its operand's READ is still in the submission queue. The caller then frees the reader's buffer (`into_inner`) and reuses the memory. No `pragma(Pragma.AllowUnsafe)`.

```yo
{ assert } :: import("std/assert");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array-list");
{ TcpListener, TcpStream } :: import("std/net/tcp");
{ SocketAddr } :: import("std/net/addr");
{ Exception, IoExn } :: import("std/error");
{ BufReader } :: import("std/io/bufio");
{ timeout, select, yield } :: import("std/async");
{ Duration } :: import("std/time/duration");

_line :: (fn(r : &BufReader(TcpStream), io : Io) -> Impl(Future(bool, Io)))(
  io.async({ r : &r.* }(e : Io) => {
    exn := Exception(
      throw : (
        err -> {
          unwind(false);
        }
      )
    );
    ioe := IoExn(io : e, exn : exn);
    got := e.await(r.read_line(e), ioe);
    got.is_some()
  })
);
_ready :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => i32(7))
);
_victim :: (fn(n : usize) -> ArrayList(u8))({
  mut(b) := ArrayList(u8).with_capacity(n);
  (mut(i) : usize) = usize(0);
  while(i < n, i = (i + usize(1)), {
    b.push(u8(66));
  });
  b
});
_count_bad :: (fn(b : &ArrayList(u8)) -> usize)({
  (mut(bad) : usize) = usize(0);
  (mut(i) : usize) = usize(0);
  while(i < b.len(), i = (i + usize(1)), {
    if(b(i) != u8(66), {
      bad = (bad + usize(1));
    });
  });
  bad
});

main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        assert(false, "unexpected exception");
        unwind(());
      }
    )
  );
  ioe := IoExn(io : io, exn : exn);
  listener := io.await(TcpListener.bind(SocketAddr.loopback(u16(0)), io), ioe);
  client := io.await(TcpStream.connect(listener.local_addr(), io), ioe);
  (mut(total) : usize) = usize(0);
  (mut(k) : i32) = i32(0);
  server0 := io.await(listener.accept(io), ioe);
  mut(server) := Option(TcpStream).Some(server0);
  while(k < i32(50), k = (k + i32(1)), {
    // 32 bytes, no newline: the line read would keep waiting.
    _w := io.await(client.write_str("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", io), ioe);
    io.await(yield(io), io);
    s := match(server.take(), .Some(x) => x, .None => { assert(false, "stream"); return(()); });
    reader := BufReader(TcpStream).with_capacity(s, usize(4096));
    r := io.await(select(timeout(_line(&reader, io), Duration.from_millis(i64(1000)), io), _ready(io), io), io);
    assert(match(r, .Some(.Second(v)) => (v == i32(7)), _ => false), "the ready operand wins");
    // The select is over: nothing borrows the reader. Free its buffer.
    back := reader.into_inner();
    v1 := _victim(usize(4096));
    v2 := _victim(usize(4096));
    v3 := _victim(usize(4096));
    io.await(yield(io), io);
    io.await(yield(io), io);
    total = (((total + _count_bad(&v1)) + _count_bad(&v2)) + _count_bad(&v3));
    server = .Some(back);
  });
  println(`bytes written into reused memory after select returned: ${total}`);
});
export(main);
```

```text
$ ./p1                          # develop 0d862baec (#2077), default backend
bytes written into reused memory after select returned: 1536
$ YO_IO_BACKEND=uring ./p1      # 1,440-1,536 over runs, of 50 x 32
$ YO_IO_BACKEND=epoll ./p1
bytes written into reused memory after select returned: 0
```

Run it unsanitized: under `--sanitize address --allocator system` the freed block is not reused and the kernel's write is invisible (0). The same program one level down, `select(_line(&reader, io), _ready(io), io)`, reports 0 on both backends: #2077 holds for the combinator's own abort of its loser.

### `JoinHandle.abort()` of a task awaiting `select` (the lane's `q6h`)

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
$ YO_IO_BACKEND=uring ./repro     # develop 1ce232268, and develop 0d862baec (#2077)
bytes overwritten after the join returned: 6400
$ YO_IO_BACKEND=epoll ./repro
bytes overwritten after the join returned: 0
```

When `select` itself aborts the losing operand, the buffer is safe once `select` returns. That case is fixed by `fix/abort-inflight-frame-linger` and pinned in `tests/sys/pipe.test.yo`. This issue is the abort of the task AROUND the combinator.

### The join window (VERDICTS-83 `p4`)

The holder can also be aborted after `select` has aborted its losing read and is **joining** it. Replace `_nap` in the reproducer above with an operand that completes at once:

```yo ignore
_nap :: (fn(io : Io) -> Impl(Future(i32, Io)))(io.async((e : Io) => i32(0)));
```

```text
$ YO_IO_BACKEND=uring ./p4
bytes overwritten after the join returned: 6400
```

`_scoped_join` has already taken the read's handle out of `_Scoped`, so a walk of the frame finds nothing to abort, and the holder's abort cancels the join's park at once. With `timeout` in place of `select` (`p5`) the count is also 6,400 on io_uring and 0 on epoll.

## Root cause

`select` and `timeout` run each operand as a scoped child task (`_Scoped`, `std/async/index.yo`) and suspend on a join wait, a park future. Aborting the holder aborts what it awaits: the combinator's state machine, whose await slot is that park. A park cancels synchronously, so the combinator and the holder retire at once (`__yo_future_abort` answers true), and `h.await(io)` returns. The operands are not in the await chain. They are aborted only when the combinator's state machine is disposed (`_Scoped`'s `Drop`), which happens when the holder's aborted-entry guard releases it, a queue turn later. Nothing waits for them to retire. The operand's READ, queued in the SQ, is submitted at the next enter and completes into `buf`. On epoll the operand's cancel is synchronous and the read happens only after readiness, so nothing is written.

`_Scoped`'s documentation promised "the task that runs one must never outlive the combinator's own future". On this path the operand's operation outlives it.

VERDICTS-83 adds the cause underneath: **an abort does not drop the task's frame**, on any backend. An aborted task's locals are dropped when its last handle is released (`<block>_state_dispose_locals` runs at the last release), not at the abort. `_Scoped.drop` is the only thing that aborts a combinator's operands, so it runs after the abort's observer has moved on. io_uring turns that into a write into freed memory; on epoll the operands just keep running (`issues/2026-11-25-an-aborted-tasks-locals-are-dropped-when-its-last-handle-is-released.md`).

## Fix (VERDICTS-83 §3: the abort walk)

The invariant #2077 established for the await chain is: when an abort's observer sees the task terminal, nothing the task started can touch memory any more. Scoped operands are outside the await chain and are reachable only through the frame's `_Scoped` locals, so the frame is walked during the abort. Compiler-only, no new extern, no std change:

1. **The walk.** Once an aborted task's await slot has retired (in its abort hook, or later in its aborted-entry guard), the task drops its live locals, newest first, before it wakes its waiters.
2. **The linger.** If a drop in the walk aborts a future that does not retire (`__yo_future_abort` answers false), the walk stops there, the task stays Aborting (`-4`), and it continues the walk when that future retires.
3. **Aborting an Aborting future answers "not retired".** `__yo_future_abort` reported a `-4` future as retired.
4. **A join wait added to an Aborting task cannot be cancelled** (`__yo_join_wait_add`). This closes the join window (`p4`); the walk alone does not, because `_scoped_join` has taken the handle out of `_Scoped`.
5. **A pending `IoFuture` held by a local is aborted by the walk**, like the one in the slot (`issues/2026-11-25-a-pending-io-future-dropped-with-its-task-keeps-writing-into-the-released-buffer.md`).

A model of the rule (a rewrite of the emitted C of nine programs, not a compiler change) closes every reproducer: `p1` 1,536 → 0, `q6h` 6,400 → 0, `p5` 6,400 → 0, `p4` 6,400 → 0; ASan and LeakSanitizer stay clean.

Not chosen: a scoped wait (a new extern that `timeout` and `select` would suspend on). It needs the seed to carry the symbol before std calls it (two releases, because `src/` imports `std/http/client`), it is correct only by convention (every wait must list every live scoped child, and `p4` is the window it leaves open), and it is not where the allocation-free plan goes. It stays the fallback if the walk's battery goes red. Also not chosen: removing `unsafe` from the three spawns (a wall on borrowing operands), turning a queued SQE into a NOP (leaves io-wq and buffered file reads), defaulting `auto` to epoll (leaves IOCP).

In `plans/backlog/ALLOCATION_FREE_ASYNC.md`, `io.spawn_scoped` children replace `_Scoped` (AFA-4/6); the walk then aborts each one and the block lingers. `p1`, `p4`, `p5` and `q6h` are AFA-4's acceptance.
