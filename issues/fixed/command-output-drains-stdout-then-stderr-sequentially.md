# `Command.output` drains stdout to EOF and only then stderr — a child that fills the stderr pipe deadlocks the parent

**Status: FIXED** (2026-08-29, `std/process/command.yo`). Two changes were needed:
(1) `output` drains stderr in a spawned task while awaiting the stdout drain
(handle polled with `is_finished` + awaited `yield`, consumed once terminal);
(2) the parent's pipe ends are now `O_NONBLOCK` (+ `FD_CLOEXEC`) via
`_mark_parent_end` — on macOS the kqueue runtime services pipes with a plain
`read(2)` first, so a blocking end parked the loop thread and (1) alone still
deadlocked. Regression test: `tests/process/command.test.yo` (310 KiB stderr
flood, then one stdout line). Windows still reads pipes with a blocking
`_read`: `issues/command-output-windows-pipe-read-blocks-the-event-loop.md`.
Found 2026-08-29 reading the test runner while chasing the
Linux-only `rc=124` of `tests/http/http.test.yo` (#350). **Severity:** HIGH
(silent hang): any `Command.output` over a child that writes more than the
pipe buffer (64 KiB on Linux) to stderr before it closes stdout blocks
forever — the parent is inside `_drain_fd(out_read)` waiting for an EOF the
child cannot produce because it is blocked in `write(2, …)`.

## Where

`std/process/command.yo`, `output`:

```rust
stdout_buf := e.io.await(_drain_fd(out_read, io), e);   // to EOF
stderr_buf := e.io.await(_drain_fd(err_read, io), e);   // only then
```

`yo test` runs every test child through `Command.output`
(`src/main.yo` ~2910) and concatenates stdout + stderr, so a test binary that
emits a large stderr report while stdout is still open (an AddressSanitizer /
LeakSanitizer report at exit, a chatty `--debug-*` runtime, an assertion
dump) hangs the runner on Linux; macOS pipes are also 64 KiB but the runner
there compiles tests without LSan.

## Fix

Drain both pipes concurrently in one task: spawn `_drain_fd(err_read)` with
`e.io.spawn`, await `_drain_fd(out_read)` directly, then poll the stderr
handle with `is_finished()` + `await yield` and consume it with
`JoinHandle.await` only once terminal (the same shape `fetch_with`'s deadline
race uses — a blocking `JoinHandle.await` from inside a task nests the loop,
C37). Regression test: a child (`sh -c`) that writes 256 KiB to stderr and
then 1 byte to stdout must complete.
