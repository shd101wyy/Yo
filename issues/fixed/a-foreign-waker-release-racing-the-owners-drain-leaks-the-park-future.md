# A foreign `Waker` release racing the owner's drain can free the token without dropping the park future

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-12;
raised by the std-primitives sub-audit, verified by reading).
**Status:** FIXED 2026-09-26 (`plans/PARALLELISM_SOUNDNESS.md` Phase 6). Was: OPEN. **Leak (one `__yo_io_future_t` per hit); no unsafety.** Hypothesis: the
interleaving is verified against the source; not observed.
**Where:** `src/codegen/async/runtime_core.yo` — `__yo_async_drain_xwakes` (~690-722) and the
foreign arm of `__yo_waker_release` (~765-770).

## Mechanism

Drain, per token: `wake_local(future)`; `if (load(release_pending) && future) { decr future; }`;
`store(queued, 0)`; `unref` (the inbox reference).
Foreign release: `store(release_pending, 1)`; `post` = CAS `queued` 0→1, link if it won, notify;
`unref` (the handle reference).

Interleaving: drain loads `release_pending == 0` → releaser stores 1 → releaser's CAS fails
because `queued` is still 1 (the drain has not cleared it), so the post only notifies → drain
stores `queued = 0` and unrefs → releaser unrefs → `refs` hits 0 and the token is freed. Nobody
executed the deferred `__yo_decr_rc(t->future)`: the reference `__yo_waker_new` took on the park
future is never dropped. `live_wakers` was decremented, so nothing hangs; the future leaks.

## Fix direction

Re-load `release_pending` AFTER `atomic_store(&t->queued, 0)` (seq_cst total order then makes
the failed-CAS releaser's store visible to the drain), or do the queued-clear and the
release check under `owner->lock`, as the LOCAL release path already does. Test: a Dispose
counter on a park future is not observable from Yo; pin it with the spawn-inside-spawn loop
of the companion issue under the Linux leak leg (`YO_ASAN_DETECT_LEAKS=1` if the gate exists,
else a `__yo_io_future_t` live counter exposed through a debug knob).

## Fix (2026-09-26, rule D7)

The drain consumes `release_pending` with an atomic exchange (`__yo_waker_consume_release`,
`src/codegen/async/runtime_core.yo`) and checks it TWICE: before and after its
`atomic_store(&t->queued, 0)`. A release that loses the `queued` CAS to the entry being drained
set the flag before its CAS read `queued == 1`, and that read precedes the drain's store, so the
second check is guaranteed to see it; the exchange makes the double check consume it exactly
once. With the live-waker decrement now done at consumption (the companion fix), a missed
release would hang the loop rather than leak, which is what makes the second check mandatory
rather than an optimization. Test: the stress shape in `tests/cross_thread_wake.test.yo`
(its completion count).
