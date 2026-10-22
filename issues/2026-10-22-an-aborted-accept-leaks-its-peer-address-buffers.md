# An aborted accept leaks its peer-address buffers

**Severity:** S3. Each task that is aborted while its `accept` is pending leaks 132 bytes, the 128-byte peer-address buffer and the 4-byte length cell. On Linux this makes `tests/net/unix.test.yo` fail its LeakSanitizer verdict.

> Found 2026-10-22 by B3's Tier 1 gate (`feat/v2b-b3-std-explicit-copies`).
> It reproduces with develop `e30c0d8ed`'s own std and tree binary, so B3
> did not cause it. Machine: Linux x86_64 under WSL2, kernel
> 6.18.54.1-microsoft-standard-WSL2.

## Symptom

`yo test tests/net/unix.test.yo --parallel 1` fails 1 of 8 tests, the same way
on both runs:

```text
  ✗ aborting a task whose accept is pending releases it
    Memory leak detected:
    ==3265056==ERROR: LeakSanitizer: detected memory leaks
    Direct leak of 128 byte(s) in 1 object(s) allocated from:
    ...
    Direct leak of 4 byte(s) in 1 object(s) allocated from:
    ...
    SUMMARY: AddressSanitizer: 132 byte(s) leaked in 2 allocation(s).
```

The test (`tests/net/unix.test.yo`, "aborting a task whose accept is pending
releases it") binds a listener, spawns a task that awaits `accept`, aborts
that task, and then closes the listener. The test was added for
`issues/fixed/2026-10-14-windows-af-unix-accept-blocks-the-event-loop.md`.

## Root cause

`UnixListener.accept` (`std/net/unix.yo`) takes its peer-address buffers
from `malloc` and frees them only after the await:

```yo ignore
addr_buf := (*u8)(malloc(usize(128)).unwrap());
addr_len := (*u32)(malloc(usize(4)).unwrap());
addr_len.* = u32(128);
client_fd := e.io.await(IO_unix.accept(fd, addr_buf, addr_len), e.io);
free(.Some((*void)(addr_buf)));
free(.Some((*void)(addr_len)));
```

An aborted task never resumes after its await, so the two `free` calls never
run. `TcpListener.accept` (`std/net/tcp.yo`) has the same shape. No test
aborts a pending TCP accept, so nothing reports it there.

## What a fix has to settle

Freeing the buffers on abort is safe only if the pending kernel operation is
cancelled, and the cancellation has completed, before the memory is released.
Until then the kernel may still write the peer address into it. So the fix
is either:

- the runtime's abort path cancels the pending accept and waits for that
  cancellation, and the buffers are then owned by the task, so they are
  dropped with it; or
- the I/O request owns the buffers and frees them when it completes,
  cancelled or not.

The same leak class was fixed for the HTTP read buffer in
`issues/fixed/2026-10-16-a-fetch-that-times-out-leaks-an-8-kib-buffer.md`
(#1453): `std/http/wire.yo` replaced its `malloc`/`free` pair with an owned
`ArrayList(u8)` local that lives in the state machine, so the machine's
dispose drops it on every exit path, abort included. That pattern is the
first option above for these two buffers; it still has to answer the
cancellation question for a pending `accept`.

The Windows half of the same abort path is
`issues/2026-10-20-an-abandoned-windows-blocking-accept-keeps-the-completion-port-open.md`.
The existing test is the regression test: it fails today and must pass after
the fix.
