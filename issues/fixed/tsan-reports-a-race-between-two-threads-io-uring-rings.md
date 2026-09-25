# TSan reports a race between two threads' io_uring rings, and the thread-corpus gate could never pass

**Found:** 2026-09-25, on PR #902's CI (`ThreadSanitizer (sync primitives — Linux/Clang)`, step "Run the
thread corpus under ThreadSanitizer").
**Status:** FIXED 2026-09-25. **Class:** gate defect (a sanitizer false positive, and a corpus that
listed files which never spawn a thread).

## Symptom

`scripts/tsan-thread-corpus.sh` failed on every run of #902:

```
FAIL tests/thread.test.yo rc=1 spawns=35 tsan_reports=1
    WARNING: ThreadSanitizer: data race
      Write of size 1 at 0x7feae1b9f000 by thread T4:
        #0 io_uring_prep_rw
        #1 io_uring_prep_poll_add
        #2 __yo_io_arm_notify
        #3 __yo_io_init
        #4 __yo_async_wait_all
        #5 __yo_thread_entry
      Previous write of size 1 at 0x7feae1b9f000 by thread T3:
        #0 io_uring_prep_rw ... (the same stack)
```

The same report appeared in `tests/cross_thread_wake.test.yo` and `tests/spawn_blocking.test.yo`.
Separately, `tests/thread_safety`, `tests/atomic_object` and `tests/iso_api_surface` were HOLLOW
(no thread spawned) on every run, and HOLLOW fails the gate. So the gate could not pass even
without a report.

## Cause

Each thread's event loop owns its ring: `__yo_io_ring` and `__yo_io_initialized` are
`_Thread_local` (`src/codegen/async/runtime_io_linux.yo`, `runtime_core.yo`). Two live threads
cannot share an SQE address. The address was the same because T3's ring had been torn down
(`io_uring_queue_exit`, which unmaps it) and T4's ring was then mapped at the recycled address.

TSan resets its shadow state for a range when its `munmap` interceptor sees the unmap, and
treats pages from `mmap` as new. liburing does neither through libc. The CI runner's
`liburing2 2.5-1build1` (Ubuntu noble) imports only `calloc`, `free` and `__stack_chk_fail` from
libc and makes its `mmap`, `munmap` and `io_uring_*` calls as raw `syscall` instructions (64 of
them; checked with `nm -D` and `objdump -d` on the package). TSan never learned T3's pages were
gone. T3 was a detached worker, so nothing ordered its exit before T4's start, and T4's first SQE
write looked like a race with T3's last one.

## Fix

- In a TSan build (`__has_feature(thread_sanitizer)` or `__SANITIZE_THREAD__`), the ring's three
  mapped regions (SQ ring, CQ ring, SQE array) are released to TSan at teardown
  (`__tsan_release`, just before `io_uring_queue_exit` in `__yo_io_cleanup`) and acquired at setup
  (`__tsan_acquire`, right after `io_uring_queue_init_params` in `__yo_io_init`). Each is keyed on
  the region's address. This models a real order that TSan cannot see: a `munmap` and a later
  `mmap` returning the same address both take the process's `mmap_lock`. The edge exists only when
  an address is really reused. Outside a TSan build both hooks are empty inline functions.

  The first attempt used TSan's `AnnotateNewMemory` to reset the region's shadow state, as TSan's
  own `mmap` interceptor does. It changed nothing: in LLVM's TSan runtime `AnnotateNewMemory` is a
  no-op (it only opens a scoped annotation), and CI reported the same race. With the full report
  now printed, CI showed the evidence: the previous writer "T3 (finished)", and the location
  "anon_inode:[io_uring]+0x10000000", the SQE array's mmap offset.
- `scripts/tsan-thread-corpus.sh` lists only files that spawn threads. The three files above
  check their rules at compile time or on one thread, where TSan observes nothing. The HOLLOW
  rule still catches a listed file that stops spawning.
- On a new failure, the script prints each report through its `SUMMARY` line (up to three), not
  the first twelve lines, so thread lifetimes ("finished", "created by") are in the CI log.

## Regression test

The gate itself: the thread corpus under TSan on Linux CI, which failed on every #902 run before
the fix.
