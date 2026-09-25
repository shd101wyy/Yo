# A foreign `Waker` release decrements `live_wakers` before it posts, so a spawned thread's loop can exit and be freed under the post

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-11;
raised by the std-primitives sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Use-after-free (hypothesis: the ordering is verified in the source; the
crash was not reproduced).** Only loops on SPAWNED threads are exposed: the main thread's loop
lives until process exit.
**Where:** `src/codegen/async/runtime_core.yo` — `__yo_waker_release` (~753-770),
`__yo_async_wait_all` (~460-495), `__yo_async_foreign_wake_possible` (~190).

## Mechanism

Foreign release (the token's owner loop is another thread's):

```c
atomic_fetch_sub(&owner->live_wakers, 1);   // 1. the owner may now see live_wakers == 0
atomic_store(&t->release_pending, 1);
__yo_waker_post(t);                         // 2. locks owner->lock, links, bumps xwake_count, notifies
__yo_waker_token_unref(t);
```

The owner's drain loop `__yo_async_wait_all` — which every `Thread.spawn` trampoline runs before
`__yo_io_cleanup()` and thread exit (`src/codegen/parallelism/runtime.yo`, the
`async_wait_thread` block) — exits when nothing is queued, no I/O is pending, no blocking call is
in flight, and `!foreign_wake_possible`, where `foreign_wake_possible` is
`threads_ever_spawned > 0 && live_wakers > 0`. Between step 1 and step 2 all of those are false,
so the owner can break out, tear its ring down, return from the trampoline, and let the thread
exit — after which `owner` (`&__yo_this_loop`, a `_Thread_local` static) is dead storage. Step 2
then locks and links through it.

The exact shape `spawn_blocking` produces when it is called from a task running on a spawned
thread: the worker thread does `sink.send(cb())`, `w.wake()` (drained; the awaiting task finishes),
`__yo_async_blocking_end(owner)` (inflight → 0), and THEN the closure's captured `Waker` drops →
foreign release → step 1.

```rust
// each iteration is one exposure; needs load to hit the window
t := Thread(unit).spawn((io : Io) => {
  _v := io.await(spawn_blocking(() => i32(1), io), io);
  ()
});
t.join();
```

## The same shape in `__yo_async_blocking_end`

`__yo_async_blocking_end(loop)` (`runtime_core.yo` ~199-206) does
`atomic_fetch_sub(&loop->blocking_inflight, 1)` and THEN `__yo_io_notify(loop)`. Between the two
the owner may exit on the same predicate (`!has_blocking_inflight`), so the notify can land on
the dead loop as well; the macOS notify additionally reads the handle unsynchronized
(`issues/macos-io-notify-races-io-cleanup-on-the-notify-handle.md`). When the owner is the main
thread both windows degrade to a leak (the token, the park future and the `release_pending` step
are never drained).

## Fix direction

Never let a loop observe `live_wakers == 0` while a post it will receive is still in flight:
move the decrement to the OWNER, into `__yo_async_drain_xwakes` when it consumes a token with
`release_pending` set (the owner already defers the future drop there), and keep the local
release path's decrement where it is. Then a foreign release keeps the loop alive until the loop
itself has processed the release. Test: `tests/cross_thread_wake.test.yo` gains the
spawn-inside-spawn shape above in a loop of a few thousand iterations; it is the Linux ASan leg's
job to catch the regression.

## Fix (2026-09-26, rule D7)

`src/codegen/async/runtime_core.yo`, three changes that together keep a loop alive exactly as
long as anything addressed to it is in flight:

1. **The live-waker decrement moved to the owner.** A foreign `__yo_waker_release` no longer
   touches `live_wakers`; it sets `release_pending`, posts, and drops its handle reference. The
   owner's drain decrements when it consumes the release (`__yo_waker_consume_release`), so the
   loop cannot see zero live wakers while a release addressed to it has not been processed. The
   local release keeps its immediate decrement, except when a wake is already queued, in which
   case the drain does it too.
2. **A visitor count on the loop.** Even with (1), a poster links the token under the owner's
   lock and calls `__yo_io_notify(owner)` AFTER unlocking (the Linux backend's notify takes the
   same lock, so it cannot move inside); an owner that wakes for another reason could drain,
   reach zero and exit in between, and the notify would land on dead `_Thread_local` storage.
   `__yo_waker_post` and `__yo_async_blocking_end` now bracket every touch of a foreign loop with
   `loop->visitors` (incremented while the loop is provably alive — the caller holds a waker
   reference, or the blocking bracket is still open), and `__yo_async_loop_quiesce()` runs
   before every `__yo_io_cleanup()` (both thread entry points and the async-main driver) and
   waits for it to reach zero. That also closes the `blocking_end` decrement-then-notify window
   this issue describes.
3. The drain's re-check (`issues/fixed/a-foreign-waker-release-racing-the-owners-drain-leaks-the-park-future.md`).

Test: `tests/cross_thread_wake.test.yo` "spawn_blocking from a task on a spawned thread, 2000
times" — the issue's shape, one exposure per iteration. It passed 3/3 on the unfixed runtime too
(the window is a few instructions wide and was never reproduced on macOS); the Linux ASan leg is
its oracle for the use-after-free, and its completion count is the oracle for the lost release,
which now hangs the loop instead of leaking silently.
