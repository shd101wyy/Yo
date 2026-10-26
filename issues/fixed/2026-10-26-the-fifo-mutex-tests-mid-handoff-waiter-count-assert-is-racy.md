# The FIFO mutex test's mid-handoff waiter-count assert is racy

**Severity:** S3 (a flaky CI leg; the mutex semantics it observes are correct)

## What happened

`Forced-epoll async corpus` on develop battery 40261184520 (af67fdf59, 2026-10-26)
failed one test:

```
✗ Test the lock is handed FIFO across loops, ahead of a later same-loop waiter
  Test failed with exit code 134
```

Exit 134 is a `panic` — on Linux `__yo_panic` aborts the process and its
message goes to stderr, which the selftest runner does not forward, so the log
shows only the exit code. The panicking assert is the test's third
intermediate observation, `tests/async/mutex_threads.test.yo`:

```yo
m.*.unlock();
assert(m.*.is_locked(), "the lock stays held while it is handed over");
assert(!m.*.try_lock(), "try_lock cannot take a lock handed to a waiter");
assert(m.*.waiter_count() == usize(1), "only the same-loop waiter is still queued");
```

## Root cause: the test, not the mutex

`unlock`'s `_hand_off` DEQUEUES the waiter it wakes, at wake time — not when
the waiter resumes. The test's comment assumed "the foreign waiter's loop may
not have run yet" between main's `unlock` and the asserts. That is true on one
core; on a multicore box the foreign thread runs IN PARALLEL and can execute
its whole critical section — resume, `_take`, body, `unlock`, hand the lock on
to the same-loop waiter (dequeuing it too) — before main's next instruction.
Then `is_locked()` is still true and `try_lock()` still fails (the lock was
handed to the same-loop waiter, which cannot run while main is unsuspended on
the same loop), but `waiter_count()` is `0`, not `1`: the assert fails, and
`std/assert` panics.

Nothing about the FIFO CONTRACT broke: the order is pinned by the final
asserts (`rf == 1` — the foreign waiter ran first; `rs == 12` — the same-loop
waiter ran second), which hold under every interleaving.

## Reproduction

Both tests of the file, extracted verbatim into a standalone `main`
(`tmp/mutex_repro.yo` shape), tree-built `yo` at af67fdf59, forced epoll,
both loops pinned to two CPUs — `taskset -c 2,3`:

- current `std`: **33 / 1000** runs abort with
  `only the same-loop waiter is still queued`;
- the PRE-#1617 `std` (b0572a13b's parent, compiled against a `git archive`
  snapshot of `std/`): **10 / 1000** — the race is latent and old; #1617's
  timing merely surfaced it on the runner. It is not a v3 regression.

## Fix

Assert the invariant that holds under every interleaving instead of one
particular interleaving: the foreign waiter is out of the queue, and the
same-loop waiter may or may not have been dequeued by the foreign thread's own
hand-off (it cannot have RUN — it needs main's loop, which is busy in the
test body). `waiter_count() <= usize(1)`; the order itself stays pinned by
`rf`/`rs`.

After the fix the same hammer ran **0 / 1000** failures.

Filed and fixed in the same PR; no std/compiler change — the mutex hand-off
semantics are correct as designed
(`issues/fixed/2026-10-16-the-async-mutex-is-not-fifo-across-event-loops.md`
stays authoritative for the FIFO behavior).
