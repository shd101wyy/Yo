# A foreign `Waker` release decrements `live_wakers` before it posts, so a spawned thread's loop can exit and be freed under the post

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-11;
raised by the std-primitives sub-audit, verified by reading).
**Status:** OPEN. **Use-after-free (hypothesis: the ordering is verified in the source; the
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

## Fix direction

Never let a loop observe `live_wakers == 0` while a post it will receive is still in flight:
move the decrement to the OWNER, into `__yo_async_drain_xwakes` when it consumes a token with
`release_pending` set (the owner already defers the future drop there), and keep the local
release path's decrement where it is. Then a foreign release keeps the loop alive until the loop
itself has processed the release. Test: `tests/cross_thread_wake.test.yo` gains the
spawn-inside-spawn shape above in a loop of a few thousand iterations; it is the Linux ASan leg's
job to catch the regression.
