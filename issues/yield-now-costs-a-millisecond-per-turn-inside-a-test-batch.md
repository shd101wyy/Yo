# `yield_now` costs ~1.5 ms per turn inside a test batch and ~0 outside one

**Status:** OPEN — a PERFORMANCE observation, not a correctness bug. Recorded
2026-09-11 while landing `std/async/waker.yo`, because it will otherwise mask
the next piece of async performance work.

## Measured

400 iterations of `io.await(yield_now(io), io)` inside a spawned task.

| built as | 400 `yield_now` | 400 no-op `io.async` | 400 `Park`+`wake`+`wait` | 400 timer `yield` |
| --- | --- | --- | --- | --- |
| standalone, `--optimize 2` | **0 ms** | 0 ms | 0 ms | 603 ms |
| standalone, `-O0` | **0 ms** | 0 ms | 0 ms | 609 ms |
| standalone, `--sanitize address --allocator system` | **0 ms** | 0 ms | 0 ms | 608 ms |
| inside `yo test` (`tests/async/waker.test.yo`) | **604 ms** | — | — | — |

Every loop was verified to have actually run its 400 iterations (the spawned
task returns its counter and the probe prints it) — a 0 ms reading is not a
loop that was elided.

604 ms is 1.51 ms per turn, which is almost exactly the 1 ms timer's own cost.
So inside a test batch, the timer-free yield performs like the timer it
replaces.

## What it is NOT

- Not the optimization level: `-O0` standalone is 0 ms.
- Not the sanitizer: the test runner compiles with `--sanitize address` by
  default (`src/main.yo`, "Default sanitizer is address"), and the standalone
  form under the same flag is 0 ms.
- Not accumulated state from earlier tests in the file: moving the timing test
  to the FIRST position in the batch reproduces 604 ms.
- Not the primitive: the waker relay test in the same file drives 400
  hand-offs and completes well inside its bound, and `Park`+`wake`+`wait`
  standalone is 0 ms.

## Why it matters

The whole point of `plans/WAKER_BASED_SCHEDULING.md` is removing a
millisecond floor from every hand-off, and the acceptance criterion is a
measured hand-off rate. If the measurement is taken from inside the test
harness it reads as "no improvement", which is how this nearly got mis-recorded
as a failed optimization. `tests/async/waker.test.yo` therefore asserts
CORRECTNESS plus a catastrophic-regression bound, and points here.

## Where to look

The batch binary differs from a standalone one in the shape of
`__yo_user_main` — every test body inlined into one function, dispatched by
`__yo_test_idx` — and in the runner's own flags. Something in that shape adds a
~1.5 ms wait per event-loop turn. Candidates, in the order worth checking:

1. Whether the batch's `main` runs on the async `run_until_complete` driver
   rather than the `JoinHandle.await` poll loop, and whether that driver
   reaches `__yo_io_wait()` with a timeout while a yield is parked.
2. Whether the batch binary has other pending I/O registered at all times
   (making `__yo_has_pending_io()` true, which is the gate on `__yo_io_wait`).
3. The runner's remaining flags (`--allocator`, stack size, `YO_ASYNC_STRICT`).

The artifact needed to settle it is the generated `.yo_selftest_batch_*.bin.c`,
which the runner DELETES on a successful compile — capture it by racing a copy,
or by making the batch fail to compile.
