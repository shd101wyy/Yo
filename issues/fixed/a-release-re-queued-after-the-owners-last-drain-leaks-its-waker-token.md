# A foreign release re-queued after the owner's last drain leaks its waker token

**Severity:** S3: a leak of one small allocation per occurrence, on a spawned
thread's exit, under a narrow interleaving.

> Found 2026-10-09 by the adversarial review of
> `issues/fixed/a-foreign-waker-release-registers-its-visit-after-publishing-the-release.md`.
> Not introduced by that fix: the unfixed runtime runs the same interleaving.

## Interleaving

`spawn_blocking` called from a task on a `Thread.spawn`ed thread T; worker W
holds the captured `Waker`.

1. W's `wake()` posts: the `queued` CAS wins, the inbox takes a reference,
   the token is linked (refs 2).
2. T's `__yo_async_drain_xwakes` takes the list, wakes the task, finds no
   pending release at its first check, and stores `queued = 0`.
3. W drops the waker. The foreign release registers its visit, sets
   `release_pending`, and posts: the `queued` CAS now WINS (it reads 0), so
   it takes a second inbox reference (refs 3) and heads for the lock.
4. T's second check consumes the release (`live_wakers` drops to 0) and drops
   the inbox reference it held (refs 2).
5. The task finishes; `__yo_async_wait_all` sees nothing queued yet, no live
   waker and no blocking call, and exits. `__yo_async_loop_quiesce` waits for
   W's two visits.
6. W links the token onto T's inbox, notifies, ends its visits and drops its
   handle reference (refs 1).
7. Quiesce returns, the loop is torn down, the thread exits. The token is
   still on the inbox with one reference that nothing will ever drop.

Measured by the reviewer with alloc/free counters and three window-widening
sleeps: `tokens alloc=5 free=0` with the sleeps, `alloc=5 free=5` without.

## Fix

`__yo_async_loop_quiesce` (`src/codegen/async/runtime_core.yo`) drains the
inbox once more after the visitor count reaches zero, on the owner thread.
No visitor can start then (nothing keeps the loop alive), so the drain sees
everything any visitor linked: each token's release is already consumed, and
the drain drops its inbox reference, which frees it.

## Test

None deterministic: the window is a few instructions wide and needs injected
delays to reproduce. `tests/cross_thread_wake.test.yo`'s 2000-iteration test
exercises the path; the fix adds no new state, only a drain on the owner
thread at teardown.
