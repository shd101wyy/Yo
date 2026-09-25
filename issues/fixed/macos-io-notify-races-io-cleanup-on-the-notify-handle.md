# macOS: `__yo_io_notify` reads the loop's notify handle unsynchronized against `__yo_io_cleanup` clearing it

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-22;
raised by the runtime sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Data race, macOS only** (Linux closes the same window under `loop->lock`,
`runtime_io_linux.yo` ~608-621 and ~702-716).
**Where:** `src/codegen/async/runtime_io_macos.yo` ~838-858.

## Mechanism

```c
static void __yo_io_notify(__yo_loop_t* loop) {
  if (!loop || !loop->notify_ready) return;            // plain read
  int kq = (int)(intptr_t)loop->notify_handle;          // plain read
  kevent(kq, &uev, 1, NULL, 0, NULL);
}
static void __yo_io_cleanup(void) {
  loop->notify_ready = 0; loop->notify_handle = NULL;   // plain writes, then close(kq)
```

The comment "Clear the loop's pointer FIRST so a foreign wake … does not call kevent() on a
descriptor this function is about to close" describes a TOCTOU, not a synchronization: a foreign
notify can read `ready == 1`, be preempted, and `kevent()` a closed (or by then reused)
descriptor. Together with
`issues/a-foreign-waker-release-can-post-into-a-loop-whose-thread-has-exited.md` the read can
also land on freed thread-local storage.

## Fix direction

Mirror Linux: take `loop->lock` in `__yo_io_notify` around the ready check and the `kevent`
(the lock is not held by `kevent`'s caller on this path — the "notify outside the lock" rule in
`runtime_core.yo` is about `__yo_waker_post`'s caller, and the Linux backend already takes
`loop->lock` inside notify), and clear the handle under the same lock in cleanup. Test: the
spawn-inside-spawn loop of the companion issue on the macOS leg.

## Fix (2026-09-26)

Mirrors Linux: `__yo_io_notify` (`src/codegen/async/runtime_io_macos.yo`) holds `loop->lock`
across the ready check, the handle read and the `kevent()`, and `__yo_io_init` / `__yo_io_cleanup`
set and clear the handle under the same lock, so a foreign notify either completes before the
clear or sees it. The notify's callers never hold `loop->lock` (runtime_core's post invariant).
The dead-storage half is closed by the companion fix's visitor count. Test: the stress shape in
`tests/cross_thread_wake.test.yo` on the macOS legs.
