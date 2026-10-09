# A foreign `Waker` release registers its visit after publishing the release, so the owner's loop can be freed under it

**Severity:** S1: a use-after-free in the async runtime. Any program in which a
task on a spawned thread awaits `spawn_blocking` (or any wake from another
thread whose waker is then dropped there) can write into an exited thread's
freed loop.

> Found 2026-10-09 by the macOS Intel ASan leg (`macos-26-intel`) on PR #1287,
> whose change (the test runner's batch `main`) does not touch the runtime:
> `tests/cross_thread_wake.test.yo` "spawn_blocking from a task on a spawned
> thread, 2000 times: each loop outlives the release posted into it".

## The report

```
ERROR: AddressSanitizer: heap-use-after-free ... WRITE of size 8 ... thread T2709
    #0 __yo_waker_post+0x87
    #1 __yo_waker_release+0xd6
    ... (the spawn_blocking worker dropping its captured Waker)
freed by thread T2708 here:
    #1 _pthread_tsd_cleanup   (T2708's _Thread_local storage, at its exit)
previously allocated by thread T2708 here:
    #2 dyld::ThreadLocalVariables::instantiateVariable   (__yo_init_thread_gc)
```

T2708 is the spawned thread whose task awaited `spawn_blocking`; T2709 is the
worker. The 8-byte write is `atomic_fetch_add(&owner->visitors, 1)`, the first
thing `__yo_waker_post` does.

## Mechanism

Rule D7 (`plans/reference/PARALLELISM_RULES.md`) keeps a loop alive while a
foreign thread touches it: every visitor registers in `loop->visitors` while the
loop is provably alive, and the loop's thread waits for the count to drain
before teardown. The foreign release path of `__yo_waker_release`
(`src/codegen/async/runtime_core.yo`) did:

```c
atomic_store(&t->release_pending, 1);   // 1. publish the release
__yo_waker_post(t);                     // 2. visitors++ happens in here
```

The worker had already posted its `wake()`, so the token was on the owner's
inbox. The owner's drain consumes a pending release at two checks, the second
one after `queued = 0`. Between steps 1 and 2 it can therefore take the
release, drop `live_wakers` to 0, finish the task, find nothing left to wait
for, run `__yo_async_loop_quiesce` (visitors is still 0), tear down and let the
thread exit. Step 2's `visitors++` then lands on the freed `_Thread_local`.
The visit was registered while the loop was no longer provably alive: the
release that kept it alive had already been handed over.

## Fix

The release registers its own visit before publishing `release_pending`. While
the flag is unset, the waker is still counted in `live_wakers`, so the owner
cannot exit. The post's own registration nests inside it, and the release
drops its visit after the post. `__yo_waker_post`'s comment and rule D7 now
state the ordering.

## Test

`tests/cross_thread_wake.test.yo`'s 2000-iteration test is the oracle that
caught it. The window is a few instructions wide: the test passes on most runs
of the unfixed runtime, and its ASan legs (Linux, macOS Intel) are what see the
write. A deterministic reproduction would need a delay inside the runtime
between the two steps, which the runtime has no hook for.
