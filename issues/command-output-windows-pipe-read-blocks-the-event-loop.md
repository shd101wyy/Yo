# Windows: pipe reads are a blocking `_read` — `Command.output` deadlocks on a large stderr

**Status: OPEN.** Split out of
`issues/fixed/command-output-drains-stdout-then-stderr-sequentially.md`
(2026-08-29) when its fix landed for Linux/macOS.

## What

`src/codegen/async/runtime_io_windows.yo` `__yo_async_read_start`: for
`FILE_TYPE_PIPE` / `FILE_TYPE_CHAR` handles it calls `_read(fd, …)`
synchronously and completes the future inline. A read on an empty pipe
therefore parks the event-loop THREAD, so `Command.output`'s concurrent stderr
drain task cannot run while the stdout drain is inside `_read` — a child that
writes more than the pipe buffer to stderr before closing stdout blocks in
`WriteFile`, the parent blocks in `_read`: the same deadlock the POSIX fix
removed. `Child.stdout`/`Child.stderr`/`Child.stdin` (`_drain_fd`, the stdin
write path) block the loop the same way.

`PIPE_NOWAIT` (what `__yo_sync_fcntl_setfl(O_NONBLOCK)` sets) is not a fix:
an empty pipe then fails `_read` with `ERROR_NO_DATA`, and there is no
readiness notification to wait on — Microsoft documents the mode as legacy.

## Fix

Anonymous pipes cannot be overlapped; create the child's stdio pipes as
**named pipes with `FILE_FLAG_OVERLAPPED`** on the parent end
(`CreateNamedPipe` + `CreateFile`, the usual `\\.\pipe\yo-<pid>-<n>` scheme
libuv/Rust use), associate the parent handle with the runtime's IOCP
(`__yo_win_associate_handle`), and route `_read`/`_write` on pipe handles
through the overlapped `ReadFile`/`WriteFile` path that regular files already
use. The `std/process/command.yo` side needs no change beyond dropping the
`windows` exclusion in `_mark_parent_end` once the runtime honours it.

## Test

`tests/process/command.test.yo` "Command.output drains stdout and stderr
concurrently (large stderr does not deadlock)" uses a 310 KiB stderr flood on
POSIX and a one-line stderr on Windows; switch the Windows arm to the flood
when this lands.
