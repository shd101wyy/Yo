# Windows: pipe WRITES are a blocking `_write` — a full child-stdin pipe parks the event loop

**Severity:** S1 — a full child-stdin pipe blocks the whole event-loop thread — deadlock on Windows

**Status: FIXED (2026-09-29).** The read half was fixed earlier by parking
empty-pipe reads on the event-loop tick
(`issues/fixed/command-output-windows-pipe-read-blocks-the-event-loop.md`).
Writes now run off the loop thread (below).

## What

`src/codegen/async/runtime_io_windows.yo` `__yo_async_write_start`: for
`FILE_TYPE_PIPE` / `FILE_TYPE_CHAR` handles it calls `_write(fd, …)`
synchronously and completes the future inline. When the pipe buffer is full —
a child that is not reading its stdin while the parent streams more than
64 KiB into it (`__yo_sync_pipe`'s buffer) — `_write` blocks the event-loop
thread. If the child is itself blocked writing stdout/stderr that the parked
parent can no longer drain, that is a deadlock. POSIX ends are `O_NONBLOCK`,
so the same write suspends and retries there.

Reads could be fixed with `PeekNamedPipe` (bytes-available is queryable);
there is no equivalent documented query for *write space* on an anonymous
pipe, so the parked-retry trick does not transfer.

## Fix options

1. **Named pipes with `FILE_FLAG_OVERLAPPED`** for the child-stdin pipe
   (`CreateNamedPipe` + `CreateFile`, libuv's `\\.\pipe\yo-<pid>-<n>`
   scheme): overlapped `WriteFile` completes through the runtime's IOCP like
   file/socket I/O already does. Only `Stdio.Piped` stdin needs the named
   variant, so handle-inheritance changes stay contained.
2. `NtQueryInformationFile(FilePipeLocalInformation).WriteQuotaAvailable`
   before writing, parking the write like reads — undocumented-ish but stable;
   chunk writes to the available quota.

Option 1 is the honest one.

## Test to add when fixed

A child that sleeps without reading stdin while the parent writes ≥ 128 KiB to
it via `Child.stdin`, then reads it all back — must complete without parking
unrelated tasks (assert an interleaved timer still fires).

## Fix (2026-09-29): libuv's non-overlapped-pipe design

Neither listed option was taken, for reasons found while implementing:

- **Option 1 (overlapped named pipes)** needs the pipe's direction at creation
  time. The parent's end may be overlapped, the child's must not be (a child
  writing its stdout synchronously through an overlapped handle is undefined
  per `WriteFile`'s contract). `__yo_sync_pipe` does not know which end the
  child gets. Telling it would mean a new runtime entry point called from
  `std/process`, and std cannot call a runtime symbol the seed does not emit
  (the seed compiles std into the compiler).
- **Option 2 (`WriteQuotaAvailable`)** depends on ntdll's
  `NtQueryInformationFile`, and the quota reads differently while a read is
  pending on the other end.

Instead, `__yo_async_write_start` sends a write to a `FILE_TYPE_PIPE` handle
(on a loop with a completion port) to `__yo_win_pipe_write_start`. The blocking
`WriteFile` runs on a thread-pool worker (`TrySubmitThreadpoolCallback`), which
posts the operation's OVERLAPPED to the loop's port when it returns. The loop
completes it through `__yo_win_process_completion` like any overlapped I/O.
libuv does the same for non-overlapped pipes (`UV_HANDLE_NON_OVERLAPPED_PIPE`).
Details:

- **Ordering.** Writes to one pipe form a per-handle FIFO
  (`__yo_win_pipe_writer_t`). The head is on a worker, and the next starts when
  it completes, so bytes are never reordered or interleaved.
- **Close.** The close hook fails queued writes that never started with
  `EBADF` (they would otherwise write to whatever reuses the handle). The one
  on a worker completes on its own.
- **Teardown.** While a write is still on a worker, `__yo_io_cleanup` leaves
  the port open: closing it would let the worker's post land on a port that
  later reuses the handle value.
- Console (`FILE_TYPE_CHAR`) writes stay synchronous, as does a pipe write on
  a loop with no port.

Compile-checked with `zig cc -target x86_64-windows-gnu` against C
cross-emitted for `x86_64-pc-windows-gnu` (`-Werror=implicit-function-declaration`,
`incompatible-pointer-types`, `int-conversion`). The Windows CI legs run it.

Test: `tests/process/command.test.yo` "a child-stdin write larger than the pipe
buffer does not park the event loop". The child sleeps ~1 s before reading
(`ping` on Windows, `sleep` on POSIX). The parent writes 256 KiB, four times the
pipe buffer, and a 100 ms timer spawned before the write must have finished
when it returns. Before the fix the write held the loop thread for the whole
second, so the timer could not fire. POSIX always passed (non-blocking ends).
