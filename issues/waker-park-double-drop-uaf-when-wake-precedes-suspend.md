# Waker/Park double-drop: heap-use-after-free when a wake precedes the suspend

**Status: open (2026-09-11). PRE-EXISTING on develop — reproduced on a pristine
`origin/develop` checkout (52b48872c) with no other patches, so it is NOT
attributable to in-flight PRs.** Found by CI (test.yml, ubuntu-24.04-arm,
"Run tests") on PR #565's merge preview; the baseline PR
(docs/session-learnings-2026-09-11, which carries the waker tests but not
#565) fails identically.

## Symptom (verbatim)

```
✗ Test a wake before the park suspends is not lost
    Test failed with exit code 6
==4889==ERROR: AddressSanitizer: heap-use-after-free on address 0x507000003824
READ of size 1 at 0x507000003824 thread T1
    #0 __yo_decr_rc
    #1 yo_id_17469
    #2 __yo_decr_rc_tracked
    #3 __yo_decr_rc
    #4 __yo_user_main
freed by thread T1 here:
    #1 __yo_decr_rc
    #2 __yo_waker_release
    #3 yo_id_13297
    #4 yo_id_17471
    #5 __yo_decr_rc
    #6 __yo_user_main
previously allocated by thread T1 here:
    #1 __yo_rc_alloc
    #2 __yo_async_park_start
    #3 yo_id_13300
    #4 __yo_user_main
```

5 of 8 tests in tests/async/waker.test.yo fail (exit 6 = abort); the rest pass.

## Reproducer

tests/async/waker.test.yo "Test a wake before the park suspends is not lost":

```rust
p := Park.new();          // __yo_async_park_start: rc = 1
w := p.waker();           // __yo_waker_new: incr → rc = 2 (the token's hold)
w.wake();                 // sets the wake flag; nobody suspended, no continuation
io.await(p.wait(io), io); // already woken → inline fast-path resolves
// scope end: Waker.Dispose → __yo_waker_release → dec → rc hits 0 → FREED,
// then a further dec on the same allocation → UAF.
```

## Analysis

The reference accounting is asymmetric along the await path:

- `__yo_async_park_start` allocates with `ref_count = 1` — owned by the
  `Park._future` handle.
- `__yo_waker_new` increments — owned by the `Waker` token; balanced by
  `__yo_waker_release`.
- `Park.wait`'s `io.await(self._future, io)` shares the future with `p` and
  `w`, but the await-completion / deferred-drop path decrements the future as
  if the await had CONSUMED a reference of its own. With the shared handle the
  count reaches 0 inside `__yo_waker_release` (freeing the park while
  `Park._future` still owns it), and the caller's own final dec then reads the
  freed header.

Net: +2 increments vs 3 decrements for one park with one waker.

## Fix directions

1. **Runtime**: `IoFuture` await must not dec a future it does not own (or
   must take a reference for the duration of the await).
2. **std**: `Park.wait` gives the await its own reference for the duration
   (an increment before the await, released after) — but Yo code has no
   reachable `__yo_incr_rc` today, so this likely wants a small std/runtime
   addition.

Either side fixes the test; the decision is which side owns the borrow.

## Environment

yo v0.2.30 seed → develop 52b48872c, macOS aarch64 (locally) and
ubuntu-24.04-arm (CI, with TEST_SANITIZER).
