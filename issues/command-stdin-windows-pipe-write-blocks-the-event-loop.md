# Windows: pipe WRITES are a blocking `_write` — a full child-stdin pipe parks the event loop

**Status: OPEN.** The read half of this was fixed by parking empty-pipe reads
on the event-loop tick
(`issues/fixed/command-output-windows-pipe-read-blocks-the-event-loop.md`);
writes still go through the synchronous branch.

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
