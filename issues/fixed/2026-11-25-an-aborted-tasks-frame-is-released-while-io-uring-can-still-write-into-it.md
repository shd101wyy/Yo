# An aborted task's frame is released while io_uring can still write into it

**Severity:** S1 — aborting a task suspended in a read (`JoinHandle.abort()`, a losing `select` operand, a `timeout`) released the task's state machine at once, and on the io_uring backend the kernel then wrote the read's data into that freed block: a silent heap corruption of whatever reused it.

- Filed: 2026-11-25 (lane q6-abort-uring, v0.2.80; the question VERDICTS-81 §3 raised for in-place operations, asked of today's runtime).
- Status: FIXED by the `fix/abort-inflight-frame-linger` PR.

## Reproducer

A task reads a pipe into a buffer that is one of its own locals (so it lives in the task's heap block) and is aborted while the READ is still queued. A second task of the same type then takes the released block from its type's pool, fills the buffer with `B` and lets the loop run:

```yo
pragma(Pragma.AllowUnsafe);
{ assert } :: import("std/assert");
{ printf } :: import("std/libc/stdio");
{ write } :: import("std/libc/unistd");
pipe_io :: import("std/sys/pipe");
file :: import("std/sys/file");
fcntl :: import("std/sys/fcntl");
{ O_NONBLOCK } :: import("std/sys/constants");
{ yield } :: import("std/async");

_reader :: (fn(fd : i32, mode : i32, io : Io) -> Impl(Future(i32, Io)))(
  io.async((e : Io) => {
    mut(b_uninit) := MaybeUninit(Array(u8, usize(256))).new();
    b := (*u8)(b_uninit.as_ptr());
    if(mode == i32(0), {
      n := e.await(file.read(fd, b, u32(256), u64.MAX), e);
      n + i32(b.*)
    }, {
      (mut(i) : usize) = usize(0);
      while(i < usize(256), i = (i + usize(1)), {
        (b.add(i)).* = u8(66);
      });
      e.await(yield(e), e);
      e.await(yield(e), e);
      (mut(bad) : i32) = i32(0);
      (mut(j) : usize) = usize(0);
      while(j < usize(256), j = (j + usize(1)), {
        if((b.add(j)).* != u8(66), {
          bad = (bad + i32(1));
        });
      });
      bad
    })
  })
);

_spawn_write_abort :: (fn(rfd : i32, wfd : i32, io : Io) -> unit)({
  h := io.spawn(_reader(rfd, i32(0), io), io);
  unsafe(write(int(wfd), (*void)((*u8)("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")), usize(32)));
  h.abort();
});

main :: (fn(io : Io) -> unit)({
  mut(fds_uninit) := MaybeUninit(Array(i32, usize(2))).new();
  fds := (*i32)(fds_uninit.as_ptr());
  assert(pipe_io.pipe(fds) == i32(0), "pipe");
  rfd := fds.*;
  wfd := (fds.add(usize(1))).*;
  assert(fcntl.setfl(rfd, fcntl.getfl(rfd) | O_NONBLOCK) == i32(0), "nonblocking");
  (mut(total_bad) : i32) = i32(0);
  (mut(k) : i32) = i32(0);
  while(k < i32(20), k = (k + i32(1)), {
    _spawn_write_abort(rfd, wfd, io);
    bad := io.await(_reader(rfd, i32(1), io), io);
    total_bad = (total_bad + bad);
  });
  unsafe(printf("corrupted bytes in reused frames: %d\n", total_bad));
});
export(main);
```

On develop `1ce232268` (`yo compile`, default allocator, no sanitizer):

```text
$ YO_IO_BACKEND=uring ./repro
corrupted bytes in reused frames: 640
$ YO_IO_BACKEND=epoll ./repro
corrupted bytes in reused frames: 0
```

640 = 20 × 32: every aborted READ wrote its 32 bytes into the block the next task was using. AddressSanitizer does not see it (a kernel write is not instrumented, and ASan turns the state-machine pools off). It does see the userspace half of the same bug: a `recvfrom` aborted in flight whose address-length word is a local of the task (`tests/sys/socketpair.test.yo`, "an aborted task's frame outlives the recvfrom it was suspended in"). The ring's `-ECANCELED` completion writes `msg_namelen` back through the caller's pointer:

```text
==1893971==ERROR: AddressSanitizer: heap-use-after-free on address 0x74e05bdec124
WRITE of size 4 at 0x74e05bdec124 thread T1
0x74e05bdec124 is located 228 bytes inside of 304-byte region
```

## Root cause

`JoinHandle.abort()` runs the task's abort hook (`<block>_cancel_pending`, `src/codegen/async/state-machine.yo`), which calls `__yo_async_io_cancel` on the operation in its await slot. When that returns true the hook releases the slot, wakes the task's waiters and drops the task's own reference. The block is freed as soon as the handle goes.

`__yo_async_io_cancel` returns true when the backend's `cancel_fn` says so, and its contract was "the backend confirms the registration is gone". The io_uring hooks (`__yo_ring_fd_future_cancel` for read, write, recv, send, accept and connect; `__yo_dgram_future_cancel` for sendto and recvfrom) only queue an `IORING_OP_ASYNC_CANCEL` SQE and returned true. The kernel still owns the buffer until the operation's own CQE:

1. **A READ still queued in the SQ at the abort.** SQEs are submitted at the loop's next enter, and the cancel is queued behind the READ, so the READ reaches the kernel first. With data available it completes inline, into the freed block (the reproducer). Every abort in the same tick as the read's start hits this: `select` and `timeout` operands, spawn-then-abort, an abort from another task in the same drain pass.
2. **An operation the kernel cannot take back.** An io-wq request that has started is not interrupted by ASYNC_CANCEL (`-EALREADY`), and a buffered read waiting on the page cache is not found (`-ENOENT`). Both complete later.
3. **The completion's own userspace write.** `__yo_io_process_cqe` writes recvfrom's address length through the caller's pointer when the CQE arrives, cancelled or not.

A submitted, poll-armed read on a pipe or socket was safe in practice: the ring runs with `DEFER_TASKRUN`, so the cancel is processed before the deferred retry that would copy the data (the reproducer with a yield between spawn and abort reports 0).

The same shape held one level up. A task awaiting a child future (`stream.read(&mut buf, io)` is an `io.async` child) aborts the child (`__yo_future_abort`), and the child's hook woke its waiters, the parent among them, whatever its operation's state. The parent's aborted-entry guard then released the parent, whose local `buf` the child's operation was writing into. So even the fallback that kept the child alive until its operation completed (an operation with no cancel path) let the parent, which owned the buffer, go first. The join in `std/async`'s `timeout`, `select` and `race_first` resolved on the `-2` the abort set, before the operation retired.

Backends, by reading the code:

| Backend | Cancel | Verdict |
| ------- | ------ | ------- |
| io_uring (Linux) | asynchronous ASYNC_CANCEL | unsafe (reproduced) |
| epoll (Linux) | `__yo_epoll_cancel` removes the waiter; the `read`/`recv` runs in userspace only after readiness | safe (reproducer reports 0) |
| kqueue (macOS) | `__yo_kq_cancel` unlinks the parked op; transfers happen in userspace after readiness | safe |
| IOCP (Windows) | `__yo_win_sock_cancel` issued `CancelIoEx` and released the future at once; `CancelIoEx` only requests cancellation, and a WSARecv racing it fills the caller's `WSABUF` | unsafe by reading (not reproduced; no Windows box) |
| wasm | timers only | safe |

## Fix

An aborted task lingers until the operation its abort could not take back retires (VERDICTS-81 §3, "an aborted task's block is released when its last in-flight operation retires"):

- `__yo_async_io_cancel`'s contract is now "true only when the kernel will never again touch the operation's memory". The io_uring and IOCP socket hooks request the cancellation and answer false, so the continuation stays and the completion (`-ECANCELED`, or the result if it won the race) resumes the task.
- The abort hook returns whether the task retired (`bool (*cancel_pending)(void*, int)`), and `__yo_future_abort` returns it. A task whose slot operation, or whose awaited child, did not retire becomes **Aborting** (state `-4`) and keeps its waiters and its own reference. Its aborted-entry guard, run by that completion, marks it `-2`, wakes its waiters, releases the slot and itself. A parent awaiting an Aborting child is Aborting too, so the whole await chain, and every buffer lent down it, lives until the operation is done.
- `-4` is not terminal to a join (`__yo_join_wait_add`), to the loops that drive an `await` to completion, or to an `io.await` of the task. `JoinHandle.state`, `is_finished` and `io.state` read it as `Aborted`. So `h.abort(); h.await(io)`, and the joins in `timeout`, `select` and `race_first`, return once the operation has retired: one loop turn for a cancelled ring read.
- A raw `IoFuture` aborted directly keeps its waiters until its completion when the backend cannot take it back.
- Windows: `__yo_win_sock_cancel` issues `CancelIoEx` and answers false. The packet completes the future through the ordinary path, and the `sock_abandoned` drop path is gone.

Tests: `tests/sys/socketpair.test.yo` (the recvfrom case, failing under ASan before the fix) and `tests/sys/pipe.test.yo` (the reproducer above, failing in an unsanitized run before the fix), each on the default backend and on the epoll fallback.

## Not covered (filed separately)

- `issues/2026-11-25-aborting-a-task-that-awaits-timeout-or-select-returns-its-join-while-the-operands-read-is-in-flight.md`: a combinator's scoped operands are not in the await chain. Aborting the task around a `select` or `timeout` retires it at once and aborts the operands only at the combinator's dispose, so their operations outlive the join (io_uring; reproduced with and without this fix).
- `issues/2026-11-25-a-pending-io-future-dropped-with-its-task-keeps-writing-into-the-released-buffer.md`: a started, un-awaited named `IoFuture` is not cancelled when its task is released, on every backend (an epoll ASan heap-use-after-free).
- A raw `IoFuture` spawned and aborted directly: waiters registered before the abort now wait for its completion, but a join started after the abort reads the `-2` at once. Its buffer comes from a raw pointer, which is the caller's to keep alive. Making the join wait would need an Aborting state on I/O futures and every backend's completion path to keep it, which this fix does not take on.
