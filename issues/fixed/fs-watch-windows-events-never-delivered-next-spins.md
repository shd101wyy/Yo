# `std/fs/watch` on Windows: events are never delivered — `next(io)` spins and the suite hangs

**Status: FIXED (2026-08-30).** Root cause was NOT ReadDirectoryChangesW —
the RDCW machinery works (proved by [fsw] instrumentation on a live runner:
start, completion, callback all fire). The hole was `__yo_io_poll`
(`src/codegen/async/runtime_io_windows.yo`): its empty-completion-port early
returns (WAIT_TIMEOUT / error) skipped `__yo_poll_and_fs_event_tick`. A
yield-driven wait (`Watcher.next`, every `is_finished()` race) keeps the
ready queue non-empty, so `__yo_io_wait` — whose timeout path DOES tick — is
never reached, and the 0-timeout poll was the only tick driver: the RDCW
completion was never serviced and `next(io)` span until the deadline killed
the child. The poll-based test passed only because its `sleep(250)` await
reached `__yo_io_wait`. Fix: the early returns now run
`__yo_win_timer_process_due + __yo_poll_and_fs_event_tick`, exactly like the
success path and like `__yo_io_wait`'s failure path — which also hardens the
C57 parked pipe reads against the same yield-loop starvation. All 4
tests/fs/watch.test.yo tests pass on windows-latest with a clean exit; the
`SkipWindows` pragma is removed.
 Found 2026-08-29 by PR #348's `test (windows-latest)` leg:
"Run tests" sat for 2+ hours (the whole suite hung) while every other target
passed; the run was cancelled. **Severity:** MEDIUM — `fs.watch` is unusable
on Windows and, worse, a `next(io)` loop never terminates there.

## Where

`src/codegen/async/runtime_io_windows.yo` implements `__yo_fs_event_start`
with `ReadDirectoryChangesW` (line ~3878) and re-arms it on completion
(~4151), and `runtime_io_common.yo`'s snapshot-diff path is macOS/Linux
only. `Watcher.next` (`std/fs/watch.yo`) is a `yield`-driven wait:

```rust
while(runtime((self._head >= self._queue.len()) && self._active), {
  io.await(yield(io), io);
});
```

If the Windows runtime never fires the fs-event callback — the overlapped
completion is not drained by the tick the `yield` race reaches, or the
callback's `user_data` → `Watcher` dispatch does not run — the loop is
infinite. That matches a suite that neither fails nor finishes.

## To do

1. Reproduce on a Windows host: `yo test tests/fs/watch.test.yo -v` with
   `--debug-async-await`; confirm whether `__yo_fs_event_*` completions reach
   `__yo_poll_and_fs_event_tick` while a task is always ready (the
   io_uring `DEFER_TASKRUN` class on Linux had the same shape —
   `issues/fixed/io-uring-defer-taskrun-poll-never-enters-kernel.md`).
2. Until then `tests/fs/watch.test.yo` is gated `pragma(Pragma.SkipWindows)`
   and the §7 row records fs.watch as verified on macOS + Linux only.
3. Consider a deadline parameter on `next` so a silent backend cannot hang a
   caller forever (API addition, additive).
