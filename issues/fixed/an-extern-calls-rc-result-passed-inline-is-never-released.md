# An extern call's RC result passed inline is never released

**Severity:** S3. This affects unsafe code only. A raw `__yo_async_*_start` future passed straight to `io.spawn` or `io.await`, rather than bound to a name, leaks its future and, for a yield, its list node.

**Status: FIXED (2026-10-01).** It closes `issues/fixed/a-raw-extern-io-future-awaited-synchronously-as-a-temporary-is-never-released.md`. It is also the leak behind `tests/async/sm_protocol.test.yo`'s "a JoinHandle of a raw I/O future reads its result and can abort it", under leak verdicts.

## Symptom

`io.spawn(unsafe(__yo_async_yield_start()), io)` and `io.await(unsafe(__yo_async_yield_start()), io)` each lose 64 B. The abort case also loses the 16 B yield node.

## Cause

There were two:
1. **The temp was never declared.** The evaluator gives every non-`__yo_as` extern call an owning temp and schedules its scope-end drop (`calls/function.yo`). The extern path of `generate_other_function_call` (`src/codegen/exprs/other_fn_call.yo`) always returned the call inline, so that temp was never declared and its drop was skipped. A binding declares the temp itself, which is why `f := unsafe(…)` did not leak.
2. **An aborted yield stayed parked at thread exit.** The per-thread `__yo_yield_pending` list holds a reference to each yield future. An abort has no cancel path for a yield, nothing drives the loop again, and the thread-exit hook never released pending yields.

## Fix

- An extern call whose owning temp holds an RC value is materialized into that temp, and stored into its task slot when it has one, as the direct-call path does.
- The thread-exit hook (`__yo_async_free_cont_pool`, `src/codegen/async/runtime_core.yo`) releases every pending yield node, and `__yo_async_yield_start` arms that hook.

Tests: `tests/async/sm_protocol.test.yo` under leak verdicts. The raw futures are not observable with a `Dispose` counter.
