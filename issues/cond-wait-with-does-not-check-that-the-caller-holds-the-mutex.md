# `Cond.wait_with(m)` does not check that the caller holds `m`, so safe code reaches condvar UB

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-5).
**Status:** OPEN. **Undefined behaviour reachable from safe code** (POSIX: `pthread_cond_wait`
on a mutex the caller does not own; Windows: `SleepConditionVariableCS` on a critical section
not entered exactly once).
**Measured:** by reading `std/sync/cond.yo` (~109, ~151), `std/sync/mutex.yo` (~242) and the C
macros in `src/codegen/types/generation.yo` (~604-744); not run — the misuse cannot be run safely.

## Mechanism

`wait_with` / `wait_timeout_with` are the PUBLIC forms ("the door for everyone else", per their
doc): a pragma-free file may call `cv.wait_with(m)`. They fetch `m._raw_handle_ptr()` and hand it
to the C wait. Nothing ties the call to an enclosing `m.with_lock`: the caller may hold no lock,
hold a DIFFERENT mutex, or (Windows, recursive `CRITICAL_SECTION`) hold `m` twice through nested
`with_lock` calls, which the wait then releases one level of. glibc and macOS, on a default
(non-error-checking) mutex, "unlock" it anyway and return holding it, so the mutex is left locked
with no owner and the next `with_lock` deadlocks; `LeaveCriticalSection` by a non-owner corrupts
the section.

```rust
m := Mutex(i32).new(i32(0));
cv := Cond.new();
_ := cv.wait_timeout_with(m, Duration.from_millis(i64(10)));  // no lock held: UB
m.with_lock(v => v);                                          // POSIX: never returns
```

Every test (`tests/sync/cond.test.yo`, `timedwait.test.yo`) calls it inside `with_lock`.

## Why the guard cannot be the closure

`with_lock`'s `inout(v)` is second-class, so the body cannot hand `v` to `wait_with` as a proof of
holding; the primitive has no guard value. The proof therefore has to be RUNTIME state on the
mutex.

## Fix direction (Phase 4 of the plan: "primitives trap, never UB")

`Mutex(T)` records its owner: `_owner : AtomicUsize` (the thread id from `__yo_thread_self()`,
Release store after the OS lock returns) and `_depth : AtomicI32` (Windows recursion). `_raw_lock`
sets them, `_raw_unlock` clears them; `wait_with` panics unless `_owner == me && _depth == 1`
before it parks, and the same check guards `wait_timeout_with`. One relaxed load and one
release store per lock/unlock; the trap message names the API. `RawMutex` gets the same owner
tracking (`issues/rawmutex-is-exported-with-an-unbalanced-unlock.md`). Tests: a
`comptime_expect_error`-free RUNTIME test that `wait_with` outside `with_lock` traps (rc 134 with
the message), and that the in-lock path is unchanged.
