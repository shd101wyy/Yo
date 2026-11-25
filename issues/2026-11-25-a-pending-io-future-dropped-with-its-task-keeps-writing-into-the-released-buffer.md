# A pending IoFuture dropped with its task keeps writing into the released buffer

**Severity:** S1 — in a `pragma(Pragma.AllowUnsafe)` file, a task that starts a `std/sys` operation as a named `IoFuture` and is released before awaiting it (aborted while suspended elsewhere, or finishing without the await) frees the buffer it gave the operation while the operation still runs: a heap-use-after-free write on every backend. Safe code cannot reach it.

- Filed: 2026-11-25 (lane q6-abort-uring, v0.2.80; found next to `issues/fixed/2026-11-25-an-aborted-tasks-frame-is-released-while-io-uring-can-still-write-into-it.md`, which this does not cover).
- Amended: 2026-11-25 by VERDICTS-83 (the reach, the design).
- Status: open until AFA-8 (`plans/backlog/ALLOCATION_FREE_ASYNC.md`). Known open in v0.2.80. The abort path is closed by VERDICTS-83 §3 part 5 (the first v0.2.81 PR); the finish and scope-end path stays the caller's obligation until AFA-8.

## Reach

Not from safe code. It needs a raw pointer handed to a `std/sys` operation, and a safe file can neither name nor pass one (VERDICTS-83 probes `s1`, `s4`):

```text
error: Raw pointer types ('*(u8)') are not available in safe code.
error: Raw pointer values are not available in safe code: '(b.as_ptr)()' has type '*(u8)'.
```

No std code above `std/sys` binds a started operation to a name: a census of the 33 single-line `std/sys` operation names, of `IO_*.` calls outside an `await(`, and of `IoFuture` in signatures finds every operation awaited where it is made (a grep, not a type-level check). A named future that is awaited directly is covered by #2077, because the await moves it into the slot. So the reach is an `AllowUnsafe` file that binds a `std/sys` operation to a name and suspends or ends before awaiting it. It does not touch the safe-code claim.

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

## Decision (VERDICTS-83 §4, issue 2)

- **Final design: AFA-8.** Operations become cold, so a named one was never started and a started one exists only in an await slot. Until then a started operation behaves like a spawned task: dropping its handle detaches it, and aborting its owner aborts it.
- **The abort path (v0.2.81):** the abort walk (VERDICTS-83 §3 part 5) aborts a pending `IoFuture` held by a local, like the one in the await slot, and the task lingers on it when the backend cannot take it back. The ASan reproducer above is clean on epoll under the model, and on io_uring the task lingers on the operation.
- **The finish and scope-end path stays the caller's obligation** (probe `p7`: the task finishes with its named `recv` pending; an epoll heap-use-after-free with or without the walk). `std/sys/future.yo` says so: the memory given to an operation stays valid until its future is terminal, and a dropped pending operation is not cancelled. The guard-rail grep gate (`scripts/check-io-guard-rails.sh`, CI `tree-hygiene`) keeps `IoFuture` out of std above `std/sys`.

Rejected: a static rule ("a named `IoFuture` is awaited before its scope ends") does not cover the abort path unless it also forbids a suspension while one is live; it would be a new diagnostic for the unsafe layer that AFA-8 deletes. Cancel-on-drop everywhere cannot linger a scope end, and it silently changes which fire-and-forget operations run.
