# Windows: pipe reads were a blocking `_read` — `Command.output` deadlocked on a large stream

**Status: FIXED (2026-08-30).** Split out of
`issues/fixed/command-output-drains-stdout-then-stderr-sequentially.md`
(2026-08-29) when its fix landed for Linux/macOS. The write-side residue is
`issues/command-stdin-windows-pipe-write-blocks-the-event-loop.md`.

## What

`src/codegen/async/runtime_io_windows.yo` `__yo_async_read_start`: for
`FILE_TYPE_PIPE` / `FILE_TYPE_CHAR` handles it called `_read(fd, …)`
synchronously and completed the future inline. A read on an empty pipe
therefore parked the event-loop THREAD, so `Command.output`'s concurrent
stderr drain task could not run while the stdout drain was inside `_read` — a
child that wrote more than the pipe buffer to one stream before closing the
other blocked in `WriteFile`, the parent blocked in `_read`: the same deadlock
the POSIX fix removed.

This is what hung the Windows suite legs on the concurrent-drain PR: the test
runner runs every test child through `Command.output`, the spawned stderr
drain ran first and parked the loop in `_read` on the child's (empty) stderr
pipe, and any child printing more than the pipe buffer of stdout (`_pipe`'s
buffer was 4 KiB — `tests/cycle_collector.test.yo` "Test freeing many objects"
prints ~300 `Disposing` lines ≈ 9 KiB) blocked forever and was killed by the
per-test deadline (exit 143).

`PIPE_NOWAIT` (what `__yo_sync_fcntl_setfl(O_NONBLOCK)` would set) is not a
fix: an empty pipe then fails `_read` with `ERROR_NO_DATA`, and there is no
readiness notification to wait on — Microsoft documents the mode as legacy.

## Fix (parked reads, not named pipes)

Anonymous pipes cannot be overlapped. Rather than switching `__yo_sync_pipe`
to `CreateNamedPipe` + `FILE_FLAG_OVERLAPPED` (the libuv scheme — viable, but
it changes handle inheritance and touches every pipe consumer), the runtime
now services pipe reads the way the poll machinery already services pipes,
with `PeekNamedPipe`:

- `__yo_async_read_start` (`FILE_TYPE_PIPE` only; `FILE_TYPE_CHAR` console
  reads keep the blocking `_read`): `PeekNamedPipe` first. Data available →
  `_read` (returns immediately once bytes are buffered) and complete inline.
  `ERROR_BROKEN_PIPE`/`ERROR_NO_DATA`/`ERROR_PIPE_NOT_CONNECTED` → EOF
  (result 0). Empty but open → park the read on a thread-local
  `__yo_win_pipe_read_t` list and count it in `__yo_pending_io_count`.
- `__yo_poll_and_fs_event_tick` retries every parked read each tick and
  completes via `__yo_io_wake_continuation`.
- `__yo_io_wait` caps the IOCP wait at 10 ms while any read is parked, so the
  tick actually runs (same pattern as the fs-watch 50 ms cap).
- `__yo_sync_pipe`'s buffer went 4 KiB → 64 KiB (POSIX parity), which is also
  the slack a still-blocking pipe *write* has before it parks the loop.

`std/process/command.yo` needed no change: `_mark_parent_end` still skips
`O_NONBLOCK` on Windows (nothing to set), and `_drain_fd`'s awaited
`IO_file.read` now suspends properly on an empty pipe.

## Test

`tests/process/command.test.yo` "Command.output drains stdout and stderr
concurrently (large stderr does not deadlock)" now runs the real flood on
Windows too (a `cmd.exe` `for /L` loop writing ~305 KiB to stderr, then one
stdout line) instead of a one-line stand-in.
