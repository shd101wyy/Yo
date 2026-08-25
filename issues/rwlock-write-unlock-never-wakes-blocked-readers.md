# `RwLock.write_unlock` never wakes blocked readers — the reader branch is unreachable, and the readers hang indefinitely

**Status: OPEN.** Found 2026-08-25 by the STD_API_AUDIT scoping survey, verified
on `develop` at `340a9e735` with a red-first test that HANGS for 300 s.

## The bug

`std/sync/rwlock.yo`, `write_unlock`:

```rust
self._writer = false;
cond(
  (self._readers > i32(0)) => self._read_cv.broadcast(),
  true                     => self._write_cv.signal()
);
```

The reader branch is **unreachable**. The exclusion invariant guarantees
`_readers == 0` at this point:

- `read_lock` blocks while `_writer` is set, so no reader can increment
  `_readers` while a writer holds the lock, and
- `write_lock` only proceeds once `_readers == i32(0)`.

So the test is always false and only `_write_cv.signal()` ever runs. Readers
blocked in `_read_cv.wait` are never woken by the releasing writer.
`grep -n '_read_cv' std/sync/rwlock.yo` confirms that line is the ONLY
`broadcast` in the file.

## Severity: an indefinite hang, not a latency bug

The survey expected pthread SPURIOUS wakeups to paper over it. They do not.
Measured with the red-first test below, on macOS arm64:

```
$ timeout 300 yo test tests/sync/rwlock.test.yo --parallel 1
   ... rc=124        # timed out — the readers never woke in 5 minutes
```

With the fix, the same file passes in seconds (16 passed).

## Why the suite never caught it

`tests/sync/rwlock.test.yo:174` is named "RwLock readers wait for writer across
threads", but it calls `writer.join()` **before** spawning the readers:

```rust
writer := Thread.spawn((io) => { lock.write_lock(); ...; lock.write_unlock(); });
writer.join();                       // <-- writer is already DONE
t1 := Thread.spawn((io) => { lock.read_lock(); ... });
```

so `read_lock` never blocks and `write_unlock`'s wakeup path is never exercised.
The name describes a scenario the test does not create.

## Fix

A releasing writer cannot know which set is waiting, so it must notify both:

```rust
self._writer = false;
self._read_cv.broadcast();   // every blocked reader may proceed
self._write_cv.signal();     // at most one blocked writer may proceed
```

Both predicates are re-checked in `while` loops, so the extra wakeups are safe.

## Regression test

"RwLock readers blocked behind a held writer are woken on release" — the MAIN
thread holds the write lock while three readers arrive (confirmed via an
`arrived` counter), asserts none of them passed, then releases and joins.
Red-first: hangs on the unfixed tree (rc=124), passes after.
