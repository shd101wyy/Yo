# `abort()` of a directly spawned raw `IoFuture` is undone by the operation's completion

**Severity:** S2 — `JoinHandle.abort()` on a handle to a raw `IoFuture` is a no-op with a lie in the middle: `state()` reads `Aborted` until the operation completes, then `Completed`, and `await` returns `.Some`; the documented contract ("`await` on an aborted handle returns `.None`") does not hold for this shape.

**Status: OPEN.** Found 2026-10-03 by `plans/ASYNC_IO_API_AUDIT.md` (finding F5, probe 1). **Measured on:** develop `bcb57bfe7` built by the v0.2.49 seed, macOS arm64, `--optimize 2`.

## Symptom

`issues/repros/abort-of-a-directly-spawned-raw-io-future-is-undone-by-its-completion.yo`:

```rust
h := io.spawn(IO_timer.sleep(u64(30)), io);
h.abort();
// after abort: aborted=true
io.await(sleep(Duration.from_millis(i64(80)), io), io);
// after timer fired: aborted=false completed=true
r := h.await(io);
// await is_none=false
```

The same sequence on an `io.async` task that awaits the timer reads `Aborted` throughout and `.None` from `await` (`tests/async/join_handle.test.yo:125`).

## Cause

A raw `IoFuture` has no vtable (`vt == NULL`), so `__yo_future_abort` (`src/codegen/async/runtime_core.yo` 1250–1262) sets `state = -2` and wakes the waiters but has no `cancel_pending` hook to call: the timer stays armed in the backend. When it fires, the macOS completion writes `state = -1` unconditionally (`src/codegen/async/runtime_io_macos.yo:1335`), overwriting the abort. The Linux and Windows completion paths need the same check.

The generated cancel hook that DOES cancel is the state machine's (`src/codegen/async/state_machine.yo` 1863–1909), which acts on the raw future held in the task's `__yo_await_slot`; a raw future spawned directly is never under a hook.

## Expected

`abort()` cancels the operation where the backend has a cancel path (`__yo_async_io_cancel`), and a completion never overwrites `-2`. `state()` stays `Aborted`; `await` returns `.None`.

## Fix direction

`__yo_future_abort`: when `vt == NULL`, call `__yo_async_io_cancel(fut)` directly. Every backend's completion path: `if (state != -2) state = -1`. Regression test: the repro's three assertions, plus the same shape over a kqueue/epoll descriptor operation. Plan: `plans/ASYNC_IO_API_AUDIT.md` A3.
