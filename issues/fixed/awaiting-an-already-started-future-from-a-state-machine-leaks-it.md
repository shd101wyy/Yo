# A state machine awaiting an already-started (spawned) future leaks the future and its result

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/awaiting-an-already-started-future-from-a-state-machine-leaks-it.yo`:
`f` is spawned, and then task `a` awaits `f` while it is still pending.

```
r=7
disposed=0 (expect 1)
LEAK Direct 136 B x 1 : __yo_rc_alloc <- __yo_new_<f> <- __yo_user_main
```

Controls that pass: the same program without `io.spawn`, and a top-level
(synchronous) `io.await` of the spawned future.

## Root cause

`_emit_await_suspension_core` (`src/codegen/async/state_machine.yo`) takes
the "event loop reference" (`__yo_incr_rc(acc)`) for EVERY pending non-io
future, before testing `future_state == 0`. That reference is the one the
future's completion releases (`__yo_decr_rc(sm)` in
`emit_async_future_completion`), and it is owed only by whoever STARTS the
future. When the future is already running, whoever started it (here
`io.spawn`) already took it. The awaiter's extra increment is never
released.

The synchronous await path (`generate_await`, `src/codegen/exprs/await.yo`)
gets this right: it increments only on the cold start.

## Fix direction

Move the `__yo_incr_rc` inside the `if (future_state == 0)` cold-start
block. Regression test: the repro's dispose count (expect 1), plus the
existing cold-await tests.

## Fix (2026-09-29)

`_emit_await_suspension_core` (`src/codegen/async/state_machine.yo`) takes the running-task reference inside the `future_state == 0` cold-start block only, matching the synchronous await. A future that is already running already has the one reference its completion releases. Regression: `tests/async/sm_ownership.test.yo`, "awaiting an already-running future from a state machine releases it" (a Dispose counter).
