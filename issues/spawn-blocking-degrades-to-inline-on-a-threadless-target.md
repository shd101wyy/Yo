# `spawn_blocking` silently loses its concurrency on a target with no OS threads

**Found**: 2026-09-13, by the CI leg that first ran `tests/spawn_blocking.test.yo`
after `spawn_blocking` was exported (PR #667, run `34753610579`,
`test-wasm32_wasi`). **Status**: OPEN — the behaviour is deliberate and
correct-by-value; what is missing is any way for a caller to know about it.

## Symptom

On `wasm32-wasip1`, three of the four tests pass and the ordering one aborts:

```
✓ spawn_blocking returns the worker's value
✓ spawn_blocking carries a non-scalar result
✗ a sibling task keeps running while spawn_blocking blocks
  the event loop kept turning while the worker thread blocked
  Test failed with exit code 34304        (= 134, SIGABRT)
```

The reading is exact: the value round-trip works, and only the CONCURRENCY is
gone.

## Why

Standalone WASI has no threads — `pthread_create` fails. `__yo_thread_spawn`
(`src/codegen/parallelism/runtime.yo`) handles that by running the closure
**inline** and handing back a zero handle that `__yo_thread_join` skips:

```c
int ret = __yo_raw_thread_create(&thread.handle, __yo_thread_entry, args);
if (ret != 0) {
  // ... with no OS thread the closure would never run at all — its work
  // silently dropped and its reference-counted captures never released ...
  fn(closure);
  thread.handle = (__YO_THREAD_TYPE){0};
  return thread;
}
```

That fallback is right, and it is itself the fix for a real bug
(`issues/fixed/wasi-thread-pool-submit-deadlock.md`). But `spawn_blocking` is
built on `Thread(unit).spawn`, so it inherits it: the blocking callee runs ON
the event-loop thread, the loop cannot turn while it blocks, and no sibling
task makes progress. The awaiting task still gets the right value, just after a
fully sequential wait.

wasm32-emscripten is NOT affected — its pthread emulation really runs the
thread, and the ordering property holds there.

## Why this is filed rather than fixed

Three candidate fixes, each needing a decision this issue does not get to make:

1. **Expose `threads_available() -> bool` from `std/thread`.** Honest, and it
   makes the doc's claim checkable by a caller who cares. Needs a new `__yo_*`
   builtin, so it is seed-gated: `std/` cannot call it until a release ships
   it, which is two release cycles (`plans/backlog/SEED_VERSION_AUTOMATION.md`).
2. **Reject `spawn_blocking` at compile time on a threadless target.** Truthful
   but harsh — a program that only wants the value, and does not care that it
   arrives sequentially, stops compiling for a whole target.
3. **Leave the behaviour and document it.** What this PR does. The cost is that
   a WASI user gets sequential execution with no diagnostic at all.

(3) is not a fix, and this file exists so it is not mistaken for one.

## What was done in the meantime

- `std/thread.yo`'s `spawn_blocking` doc no longer states the sibling-task
  property unconditionally; it names the fallback, the platform, and this file.
- `tests/spawn_blocking.test.yo` asserts the DEGRADED contract on
  `Platform.Wasi` rather than skipping the test — the callee observed exactly
  zero sibling progress, and the sibling still runs to completion afterwards,
  because the loop is free again once the blocking call returns. A skip would
  have tested nothing on the one target where the behaviour differs.

## The general rule it records

A runtime fallback that preserves the VALUE while dropping a CONCURRENCY
property is invisible to every test that only checks the value — and those are
the easy tests to write, so they are the ones that exist. `spawn_blocking`'s
first two tests pass on WASI and prove nothing about what the function is for.
