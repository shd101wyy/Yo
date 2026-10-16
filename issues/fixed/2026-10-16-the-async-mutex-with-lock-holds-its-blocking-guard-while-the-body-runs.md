# The async `Mutex.with_lock` holds its blocking guard while the body runs

**Severity:** S2 — a long `with_lock` body blocked every other thread's event loop that touched the same mutex, and a body that asked its own mutex `is_locked`/`try_lock`/`get` panicked.

**Status:** fixed 2026-10-16 on `feat/vbd-async-mutex-rust` (#1380), found by
the pre-merge review of that PR.

## Symptom

`std/async/mutex.yo`'s `Mutex(T)` keeps its state under `_guard`, a
`RawMutex` (an OS mutex) documented as "held only for the few instructions
that read or write `_st`, never across an await". `with_lock` broke that: it
took the async lock, then took `_guard` and ran the caller's `body` while
holding it.

```yo
{ assert } :: import("std/assert");
{ Mutex } :: import("std/async/mutex");
main :: (fn(io : Io) -> unit)({
  m := Mutex(i64).new(i64(5));
  r := io.await(
    m.with_lock({ &m }(v : &mut i64) => {
      v = (v + i64(1));
      m.is_locked() && !m.try_lock()
    }, io),
    io
  );
  assert(r, "the body sees its own section held");
});
export(main);
```

Measured on the branch before the fix: `RawMutex.lock: locked again by the
thread that already holds it`, rc=134. On another thread the same call does not
panic: it blocks that thread, and with it every task on its loop, until `body`
returns. `_acquire_or_park` (every contended `lock(io)`) blocks the same way,
so a waiter on another loop stalled its whole loop instead of parking.

## Cause

`with_lock` wrapped `body` in `_guard.lock()`/`_guard.unlock()`. The async lock
already makes the section exclusive; the guard was redundant there, and it is
the one lock in the type that must never be held for a caller-sized span.

## Fix

`with_lock` holds the async lock alone while `body` runs. The release moved
into `_AsyncUnlocker(T)`, a private value whose `Drop` runs the unlock (the
shared `_unlock_state`, which `unlock` calls too), so every way out of the
section's frame releases the lock, as `std/sync`'s `__MutexUnlocker` does for
the blocking `with_lock`. The unlocker keeps its own handle on the guard and a
pointer into the boxed state; an earlier draft took `addr_of(self)` and crashed
(rc=139), because a `&Self` parameter can be a by-value copy in C.

The review also asked for a test where `body` unwinds. That path is not
reachable through this signature: `body` is an `Impl(Fn(...))` closure, which
cannot capture a control-bound handler, so it cannot raise an effect, and
`unwind(())` inside it returns from the closure
(`issues/questions/with-lock-and-with-permit-cannot-see-an-unwind.md`). The
unlocker covers it structurally anyway. A cross-thread "the waiter parks
instead of blocking" test needs a timing assertion and was not added; the
same-thread probe above is the deterministic witness.

## Test

`tests/async_mutex.test.yo`, "with_lock's body runs under the async lock alone
and may probe the mutex": fails before the fix (the panic above), passes after.
