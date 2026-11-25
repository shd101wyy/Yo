# A pending IoFuture dropped with its task keeps writing into the released buffer

**Severity:** S1 — a task that starts an operation as a named `IoFuture` and is released before awaiting it (aborted while suspended elsewhere, or finishing without the await) frees the buffer it gave the operation while the operation still runs: a heap-use-after-free write on every backend.

- Filed: 2026-11-25 (lane q6-abort-uring, v0.2.80; found next to `issues/fixed/2026-11-25-an-aborted-tasks-frame-is-released-while-io-uring-can-still-write-into-it.md`, which this does not cover).
- Status: open.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
{ printf } :: import("std/libc/stdio");
socketpair_io :: import("std/sys/socketpair");
tcp :: import("std/sys/tcp");
{ AF_UNIX, SOCK_STREAM } :: import("std/sys/socket");
fcntl :: import("std/sys/fcntl");
{ O_NONBLOCK } :: import("std/sys/constants");
{ yield } :: import("std/async");
{ sleep } :: import("std/sys/timer");

_spawn_named_recv_and_abort :: (fn(fd : i32, io : Io) -> unit)({
  fut := io.async((e : Io) => {
    mut(b_uninit) := MaybeUninit(Array(u8, usize(64))).new();
    b := (*u8)(b_uninit.as_ptr());
    r := tcp.recv(fd, b, usize(64), i32(0));
    e.await(sleep(u64(1000)), e);
    e.await(r, e) + i32(b.*)
  });
  h := io.spawn(fut, io);
  io.await(yield(io), io);
  h.abort();
  _r := h.await(io);
});

main :: (fn(io : Io) -> unit)({
  mut(sv_uninit) := MaybeUninit(Array(i32, usize(2))).new();
  sv := (*i32)(sv_uninit.as_ptr());
  assert(socketpair_io.socketpair(AF_UNIX, SOCK_STREAM, i32(0), sv) == i32(0), "socketpair");
  fd0 := sv.*;
  fd1 := (sv.add(usize(1))).*;
  assert(fcntl.setfl(fd0, fcntl.getfl(fd0) | O_NONBLOCK) == i32(0), "nonblocking");
  _spawn_named_recv_and_abort(fd0, io);
  assert(io.await(tcp.send(fd1, (*u8)("XXXXXXXX"), usize(8), i32(0)), io) == i32(8), "send");
  io.await(yield(io), io);
  io.await(yield(io), io);
  unsafe(printf("done\n"));
});
export(main);
```

`yo compile --sanitize address --allocator system` on develop `1ce232268`:

```text
$ YO_IO_BACKEND=epoll ./repro
==2007377==ERROR: AddressSanitizer: heap-use-after-free on address 0x7299245e0090
WRITE of size 8 at 0x7299245e0090 thread T1
$ YO_IO_BACKEND=uring ./repro
done
```

The ring run prints `done` because the kernel's write into the freed block is invisible to ASan. It is the same write.

## Root cause

The task is suspended in the `sleep`, so the abort cancels the timer. That cancel is synchronous, so the task retires and is released at once. Its dispose drops the named `r`, which only releases a reference: the backend holds its own reference to a pending future (`issues/fixed/pending-io-future-local-drop-uaf.md`), so the future cell stays valid. Nothing cancels the operation, and nothing keeps the buffer alive. When the peer's bytes arrive, the epoll backend's `recv` (or the ring's RECV, in the kernel) writes them into `b`, a local of the freed block.

The same holds without an abort: a task that finishes, or a scope that ends, with a started and un-awaited `IoFuture` bound to a name releases whatever buffer that operation was given. The abort fix (`fix/abort-inflight-frame-linger`) makes a task linger only for the operation in its await slot, the one it is suspended in.

## Recommendation

Make a pending `IoFuture`'s drop part of the lingering rule. Dropping a pending operation requests its cancellation (`cancel_fn`). When that cannot retire it synchronously, the block that owns the dropped local lingers until the operation's completion, like a task in the `-4` Aborting state. For a state machine, that means its dispose path must defer the free. Alternatively, make a named `IoFuture` move-only into an await and reject a scope end that would drop it pending (a static rule; it does not cover the abort path). This is a design question about IoFuture's drop, so it is not fixed in the abort PR.
