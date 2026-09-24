# `ThreadPool.join_all`'s sentinel barrier is defeated by a second pool, and `shutdown` can return with a task queued

**Found:** 2026-09-25, parallelism-soundness audit (`plans/PARALLELISM_SOUNDNESS.md`, finding P-7).
**Status:** OPEN. **Liveness/correctness** (no memory unsafety): `join_all` / `shutdown` return
while work submitted through the same pool is still queued.
**Measured:** by reading `std/thread.yo` (`join_all` ~236-263, `spawn` ~329-342, `shutdown`
~269-272) and the emitted runtime (`src/codegen/parallelism/runtime.yo` ~465-520). The
interleavings are scheduling hypotheses; not reproduced under a test.

## Mechanism 1 — two pools

`join_all` submits exactly `workers` sentinel tasks under THIS pool's `_mutex` and relies on the
runtime's round-robin (`__yo_worker_next_thread++ % n`, guarded only by the runtime's pool mutex,
which is released between picking the index and enqueueing) to land one sentinel on each
worker. A `spawn` through ANOTHER `ThreadPool` value takes a different `_mutex`, so it
interleaves with the sentinel loop: with 2 workers, sentinel → W0, other-pool task → W1,
sentinel → W0. W1 never gets a sentinel, `join_all` returns when W0 drains, and a task this pool
queued earlier on W1 is still pending. The type doc says two pools "drain each other's work as
well"; under concurrency the opposite can happen. `shutdown` is `join_all`, so it inherits this.

## Mechanism 2 — `shutdown` vs a concurrent `spawn`

`spawn` asserts `!_closed` BEFORE taking the submission lock; `shutdown` stores `_closed` and
then calls `join_all`. A `spawn` that passed the assert and is waiting on `_mutex` while the
sentinels are submitted enqueues BEHIND them; `shutdown` returns with that task outstanding,
against its documented contract.

## Fix direction

Both are the same fix: serialize every submission in the PROCESS against the barrier, because
the worker pool is process-global. A module-level `_submissions := RawMutex.new()` in
`std/thread.yo` (one lock for all `ThreadPool` values; the runtime already has one process-global
pool) replaces the per-pool `_mutex`, and `spawn` checks `_closed` after taking it. The barrier's
argument then holds for every pool value. The real fix — a completion counter per pool, so
`join_all` does not depend on round-robin at all — is blocked on
`issues/spawn-wrapper-forwarded-io-crosses-specializations.md` (the pool cannot wrap the user's
task closure); the plan's Phase 5 schedules it behind that codegen fix. Tests: two pools in one
test, one spamming `spawn` from a helper thread while the other calls `join_all` on slow tasks
and asserts its counter; `shutdown` racing a `spawn` on a helper thread.
