# `YO_ASYNC_STRICT=1` misses a blocking await during a spawn's cold start

**Severity:** S2 — the guard that exists to name the nested-event-loop deadlock stays silent for the one shape that deadlocks most simply (a spawned task whose first await is a blocking one in a callee), so the program hangs with no diagnostic even under `yo test`, which sets `YO_ASYNC_STRICT=1` for every test child.

**Status:** open. Found 2026-10-24 while probing the `for_await` deletion
(`plans/reference/ASYNC_ITERATION_STREAM.md`, "A `for`-equivalent"): an
`Iterator.next` that awaits, driven by a plain `for` inside a spawned task,
compiles silently and deadlocks, and the strict guard does not fire. Not
fixed in that branch, by decision.

## Reproducer

`issues/repros/2026-10-24-yo-async-strict-misses-a-blocking-await-during-a-spawns-cold-start.yo`:
an `Iterator` whose `next` awaits `Channel.recv` through an `Io` stored in a
field, driven by a plain `for` inside a spawned task, while `main` feeds the
channel after `io.spawn` returns.

| run | today | expected |
| --- | --- | --- |
| `timeout 10 ./r` | no output, rc 124 (deadlock) | the program's own bug; may still deadlock |
| `YO_ASYNC_STRICT=1 timeout 10 ./r` | no output, rc 124 (deadlock) | `panic: a blocking await ran inside an async task: …`, rc 134 |

Control: the same program with `io.await(yield(io), io);` as the task's first
statement panics under `YO_ASYNC_STRICT=1` (rc 134), because the blocking
await then runs from the scheduler rather than from the cold start.

The minimal form, which does not deadlock and so shows the silence directly
(`tests/cli-cases/async-blocking-await-during-a-spawns-cold-start`):

```yo
{ println } :: import("std/fmt");
{ Duration } :: import("std/time/duration");
{ sleep } :: import("std/time/sleep");
_blocking_helper :: (fn(io : Io) -> unit)({
  io.await(sleep(Duration.from_millis(i64(5)), io), io);
  ()
});
main :: (fn(io : Io) -> unit)({
  task := io.async((io : Io) => {
    _blocking_helper(io);
    i32(1)
  });
  h := io.spawn(task, io);
  _r := h.await(io);
  println("guard silent");
});
export(main);
```

Under `YO_ASYNC_STRICT=1` it prints `guard silent`, rc 0 (tree binary at
`f1cfa553d`, v0.2.68).

## Root cause

The guard in `__yo_async_poll_step` (`src/codegen/async/runtime_core.yo`,
C37) fires only when `__yo_async_task_depth > 0`, and that counter is
incremented in exactly one place: `__yo_async_run_task` (~:401), the
scheduler's resume of a dequeued task. `io.spawn` runs a cold task INLINE up
to its first suspension point (rule 11 of
`docs/en-US/ASYNC_AWAIT.md`'s "Important Rules"), calling its resume function directly from the
spawner's frame, so during that inline run the depth is still 0. A blocking
await reached there enters `__yo_async_poll_step` at depth 0 and nests the
event loop with the SPAWNER frozen underneath it: if the awaited I/O depends
on code the spawner runs after `io.spawn` returns (here `main`'s sends), the
program deadlocks. That is exactly the class the guard exists for
(`issues/fixed/sync-await-in-plain-fn-nests-the-event-loop.md`). The existing
cli-case `async-blocking-await-inside-task` avoids the gap on purpose: its
task suspends once first, with the comment "a cold start runs inline in
`io.spawn`, at the top level, which is not nested".

## Fix direction (not done)

Count the inline cold start of a SPAWNED task as task depth: increment
`__yo_async_task_depth` around the spawn path's direct resume call (and around
any other inline first resume whose caller continues afterwards). An inline
cold start under a plain `io.await` from `main` or a plain function is not the
same hazard (the caller is waiting for that very future), so decide that path
separately and say so in the fix.

## Test

Committed with this doc, both for an OPEN bug:

- the repro above under `issues/repros/` — the failing test, per the
  known-failing convention of `.github/instructions/testing.instructions.md`
  ("a repro for an OPEN bug is supposed to fail"); not run by any suite;
- `tests/cli-cases/async-blocking-await-during-a-spawns-cold-start`, which
  PINS today's behaviour (`guard silent`, rc 0) with `env=YO_ASYNC_STRICT=1`,
  so the fix shows up as its GOLDEN-DIFF. The fix re-records it to the panic
  line and rc 1, and moves this doc to `issues/fixed/`.
