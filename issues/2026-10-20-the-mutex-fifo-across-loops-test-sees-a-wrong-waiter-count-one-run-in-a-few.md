# The mutex FIFO-across-loops test sees a wrong waiter count one run in a few

**Severity:** S3. `tests/async/mutex_threads.test.yo` "Test the lock is handed FIFO across loops, ahead of a later same-loop waiter" fails intermittently, so a battery can go red without any change. The assertion that fails is a diagnostics count (`Mutex.waiter_count`), not the lock order itself. But the order is the point of the test, and while its precondition flakes the test cannot vouch for it.

**Status:** OPEN (triaged, not investigated). **Found:** 2026-10-20 on a 16 GB Mac Mini (darwin, Apple clang), while gating the A4 std half. It reproduces with the v0.2.66-era develop tree binary (`6ccddf25d`), so it predates that work.

## Measurements

Each run is one `yo test tests/async/mutex_threads.test.yo --std-path ./std --parallel 1`.

| binary | failures |
| --- | --- |
| develop `6ccddf25d`, tree-built | 1 of 6, and 1 in the first 3 of a run-until-fail loop |
| the A4 std-half branch's tree build | 1 of 3 |

The failure is always the same assertion:

```text
✗ Test the lock is handed FIFO across loops, ahead of a later same-loop waiter
  Test failed with exit code 6
  only the same-loop waiter is still queued (at std/assert.yo:39:17)
```

That is `assert(m.*.waiter_count() == usize(1), ...)`, read right after `m.*.unlock()` with no suspension in between. The other two tests in the file passed in every run.

## What the count should be

Main holds the lock. A thread's task queues behind it (main spins until `waiter_count() == 1`). Main then spawns a same-loop task and spins until the count is 2, then unlocks. `_hand_off` (`std/async/mutex.yo`) removes the front waiter, which is the foreign one. Its `w._thread != me`, so the lock is handed to it, and exactly one waiter, the same-loop one, should remain. All of this runs under `_guard`, with no suspension between the unlock and the read.

A count other than 1 therefore means that one of the following happened before the unlock:

- the queue held a third entry, for example a second `_acquire_or_park` from the foreign task after a spurious re-poll of its `lock` future;
- an entry left the queue early, for example an `_abandon` from a claim that was dropped.

Neither has been checked. The first step is to print the count and each entry's `(_ticket, _thread)` when the assertion fails.

## Reproducer

The test itself, run in a loop until it fails:

```bash
for i in $(seq 1 12); do yo test tests/async/mutex_threads.test.yo --parallel 1 --test-name-pattern "FIFO across loops" -v 2>&1 | grep -q "✗" && { echo "fail at run $i"; break; }; done
```
