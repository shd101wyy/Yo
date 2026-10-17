# The epoll backend leaks its recycled pendings and registrations at thread exit

**Severity:** S2. On Linux's epoll fallback, every thread that parked an fd operation leaks its recycled op records when it exits (248 bytes for one parked `recv`). The amount per thread is bounded, but a program that keeps spawning threads grows without bound.

**Status:** OPEN. Found 2026-10-17 by the `Waker.clone` Generation B gate (#1412). It is not caused by #1412: develop at `1a4cf8df6` and at `ed733408c` fail the same way.

## Symptom

`tests/sys/socketpair.test.yo` with the leak verdict on (the runner's default) fails 8 of 17. The 8 are exactly the `(epoll fallback)` tests, which set `YO_IO_BACKEND=epoll`, and every one fails as `Memory leak detected:` with a direct leak of 216 bytes plus indirect leaks. The io_uring twins of the same tests pass. CI never sees it, because `test.yml` runs with `YO_TEST_LEAK_VERDICT=0`, and the weekly `leak-verdict.yml` allowlist does not include `tests/sys/socketpair.test.yo`.

Measured with `yo-dev-ed733408c` on the Linux x86_64 box:

```text
socketpair (1a4cf8df6 tree, yo-dev-1a4cf8df6):  9 passed, 8 failed (the 8 epoll-fallback tests, all LeakSanitizer)
socketpair (ed733408c tree, yo-dev-ed733408c):  9 passed, 8 failed (the same 8)
```

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ env } :: import("std/env");
socketpair_io :: import("std/sys/socketpair");
tcp :: import("std/sys/tcp");
{ AF_UNIX, SOCK_STREAM } :: import("std/sys/socket");
fcntl :: import("std/sys/fcntl");
{ O_NONBLOCK } :: import("std/sys/constants");
main :: (fn(io : Io) -> unit)({
  env.set("YO_IO_BACKEND", "epoll");
  sv_uninit := MaybeUninit(Array(i32, usize(2))).new();
  sv := (*i32)(sv_uninit.as_ptr());
  _s := socketpair_io.socketpair(AF_UNIX, SOCK_STREAM, i32(0), sv);
  fd0 := (sv.add(usize(0))).*;
  fd1 := (sv.add(usize(1))).*;
  _a := fcntl.setfl(fd0, fcntl.getfl(fd0) | O_NONBLOCK);
  rbuf_uninit := MaybeUninit(Array(u8, usize(16))).new();
  rbuf := (*u8)(rbuf_uninit.as_ptr());
  r_fut := tcp.recv(fd0, rbuf, usize(16), i32(0));
  _w := io.await(tcp.send(fd1, (*u8)("R"), usize(1), i32(0)), io);
  _r := io.await(r_fut, io);
  io.await(tcp.close(fd0), io);
  io.await(tcp.close(fd1), io);
  ()
});
export(main);
```

Compile it with `yo compile <file> --sanitize address --allocator system` and run it. The output is `SUMMARY: AddressSanitizer: 248 byte(s) leaked in 2 allocation(s)`. Symbolized, the stacks are:

- the direct leak: `__yo_rc_alloc ← __yo_epoll_alloc_pending ← __yo_epoll_park ← __yo_epoll_recv_start`;
- the indirect leak: `__yo_rc_alloc ← __yo_epoll_alloc_reg ← __yo_epoll_park`.

Without `YO_IO_BACKEND=epoll` (io_uring), the same program reports nothing.

A yield alone (`io.await(yield(io), io)`) does not leak, because it parks no fd operation.

## Root cause

`src/codegen/async/runtime_io_linux.yo` recycles two kinds of records through thread-local free lists:

- `__yo_epoll_free_pending` pushes a finished pending onto `__yo_epoll_pending_free`;
- `__yo_epoll_free_reg` pushes a drained registration onto `__yo_epoll_reg_free`.

`__yo_epoll_teardown` frees the slot table and every record still parked, but never drains either free list. The macOS backend's teardown drains both of its lists (`__yo_io_pending_free_list` and `__yo_io_registration_free_list`), with a comment that teardown "is also the thread-exit path, where anything left here is unreachable". The io_uring teardown drains `__yo_ring_fd_node_free`. Only epoll skips this. `main` runs on a worker thread, so even the main loop's lists become unreachable when that thread exits, and LeakSanitizer reports them as direct leaks.

**Confirmed by an emitted-C A/B.** Adding the two drain loops after `__yo_free(__yo_epoll_slots)` in the repro's emitted C takes the leak from 248 bytes in 2 allocations to no LeakSanitizer report, with rc 0:

```c
while (__yo_epoll_pending_free) { __yo_epoll_pending_t* p = __yo_epoll_pending_free; __yo_epoll_pending_free = *(__yo_epoll_pending_t**)p; __yo_free(p); }
while (__yo_epoll_reg_free) { __yo_epoll_reg_t* r = __yo_epoll_reg_free; __yo_epoll_reg_free = r->next_free; __yo_free(r); }
```

## Severity rationale

S2, not S1. The leak is bounded per thread, by the peak number of operations that thread had parked at once, and it is lost only when that thread exits. It grows without bound only through thread churn on the epoll fallback. epoll is not the default where io_uring exists, but it is the backend wherever io_uring is unavailable: older kernels, or containers whose seccomp profile blocks `io_uring_setup` (Docker's default). A thread-per-task server there leaks a few hundred bytes per thread exit. Re-triage to S1 if that deployment shape is in scope.

## Fix

Drain both free lists at the end of `__yo_epoll_teardown`, mirroring the macOS backend.

## Test

The 8 epoll-fallback tests in `tests/sys/socketpair.test.yo` fail before the fix with the leak verdict on, and should pass after it. To keep CI from regressing, add `tests/sys/socketpair.test.yo` to the verdict-on allowlist in `.github/workflows/leak-verdict.yml`. First confirm that its 9 io_uring tests are leak-clean on the CI runner; they are on this box.
