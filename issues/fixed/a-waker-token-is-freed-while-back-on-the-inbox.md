# A waker token is freed while it is back on the loop's inbox — use-after-free in `__yo_async_drain_xwakes`

**Found**: 2026-09-13, by exporting `spawn_blocking` (PR #667). **Fixed**: same
day, in `src/codegen/async/runtime_core.yo`. **Class**: use-after-free in the
cross-thread wake path — the mechanism
`plans/archive/WAKER_BASED_SCHEDULING.md` step 5 added. It has been in the tree since
that landed; nothing exercised two concurrent foreign wakers until
`tests/spawn_blocking.test.yo` went live.

## Symptom

`two spawn_blocking calls in flight at once` crashes, non-deterministically,
with SIGBUS or SIGSEGV:

```
* thread #2, stop reason = EXC_BAD_ACCESS (code=2, address=0x100002b48)
    frame #0: __yo_async_drain_xwakes + 272
->  casal  w9, w22, [x10]
```

`code=2` is a write to protected memory and the address is inside the binary's
own read-only image: the drain is walking a list whose nodes are no longer
waker tokens.

It hides in the suite. Running the whole file, all four tests pass; running
this ONE test in isolation fails about nine times in ten, because the three
earlier tests change when the worker threads land. CI found it on Linux (the
full-corpus hollow sweep, which runs one file per process) while every native
leg was still green.

## Mechanism

`__yo_async_drain_xwakes` took the inbox under the lock, then for each token
cleared `queued` *before* deciding whether to free it:

```c
atomic_store(&t->queued, 0);          /* (A) the token is re-postable again */
if (t->future) __yo_waker_wake_local(t->future);
if (atomic_load(&t->release_pending)) {
  __yo_decr_rc((void*)t->future);
  __yo_free(t);                       /* (B) */
}
```

A foreign `__yo_waker_release` between (A) and (B) does exactly what it is
supposed to:

```c
atomic_store(&t->release_pending, 1);
__yo_waker_post(t);        /* CAS queued 0 -> 1 now SUCCEEDS, pushes t */
```

so the token goes back onto `loop->xwake_head` — and then (B) frees it. The
head is dangling, and the crash happens on the NEXT drain, one loop turn later,
which is why the backtrace never points at the code that caused it.

`spawn_blocking` reaches this because its worker thread does `w.wake()` and
then drops the closure's captures, which releases the waker from a thread that
is not the token's owner. One worker makes the window narrow; two make it
routine.

## Fix

Decide the token's fate before making it re-postable, and close the second
window the reorder opens:

- If `release_pending` is set, **leave `queued` at 1** and free. A concurrent
  `__yo_waker_post` then CAS-fails and only notifies, so nothing can re-enter
  the node being freed.
- Otherwise clear `queued`, then re-check `release_pending`: a release that
  landed between the load and the store saw `queued` still set and returned
  *without* pushing, so the drain is the only thing left that can reclaim the
  token. It claims it with a CAS, so that if a wake has since queued it that
  path wins instead and the next drain frees it. Exactly one of the two runs.

The diagnostic that isolated it — deleting the `__yo_free(t)` — is NOT the fix;
it leaks a token per waker. The fix still frees, in the right order.

## Measurement

Standalone reproducer (`issues/repros/two-spawn-blocking-in-flight.yo`),
A/B on the EMITTED C with clang so no compiler rebuild was needed:

| build | crashes |
| --- | --- |
| control (unmodified emitted C) | **21 / 60** |
| diagnostic: `__yo_free(t)` deleted | 0 / 20 |
| the fix | **0 / 200** |

## For the next reader

Two things this makes candidates rather than conclusions:

- **#556** (`issues/a-bodyless-http-response-is-not-read-until-the-deadline.md`)
  is "an inner `io.async` block completes and the parent await never resumes",
  timing-dependent, on both kqueue and io_uring. A token freed while still on
  the inbox can LOSE a wake instead of crashing, which is that symptom exactly.
  Not a claim — a reason to re-run #556 on top of this before reading either
  I/O backend again.
- Anything else that releases a waker from a foreign thread has been running
  against this window since step 5 landed.
