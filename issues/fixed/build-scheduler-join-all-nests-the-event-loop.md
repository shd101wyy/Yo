# `join_all` in the build scheduler nests the event loop

**Status:** FIXED (2026-09-12), same day it was introduced.
**Area:** `src/build_runner.yo` — `_execute_batch` (P1.4h, §4.8 parallel levels)
**Caught by:** the cli-case `async-blocking-await-inside-task`, whose `opts` set
`env=YO_ASYNC_STRICT=1` for the whole `yo build run`. It reported
`rc(golden=1,run=134)` — 134 is SIGABRT, the C37 guard firing.

## Symptom

Under `YO_ASYNC_STRICT=1`, ANY `yo build` that executes a node aborted:

```
panic: a blocking await ran inside an async task: an io.await in a non-io.async
function, JoinHandle.await, or a std/async combinator (join_all/race/any/timeout)
was called from a spawned or awaited task. …
```

`yo build --dry-run`, `--list-steps`, `--list-options` and `yo check` were
unaffected, which localised it to node execution. Bisected across the stack's
binaries: clean on `develop`, P1.4c, P1.4d, P1.4e, P1.4f and P1.4g; the first
tree that aborts is P1.4h.

## Root cause

P1.4h runs a DAG level's ready nodes as spawned tasks and collected them with
`std/async`'s `join_all`:

```yo
handles.push(e.io.spawn(_execute_node_unless_blocked(…), e));
…
outs := join_all(handles, e.io);
```

`join_all` awaits each handle in turn, and `JoinHandle.await` on a handle that
has NOT finished emits a blocking poll loop:

```c
while (__jh_state != -1 && __jh_state != -2) { __yo_async_poll_step(); … }
```

`_execute_batch` is part of `run_build`'s `io.async` body, and that body runs as
a RESUMED continuation (`__yo_async_run_ready_tasks` increments
`__yo_async_task_depth` around every resume). So the loop above re-enters the
event loop from inside a task — the exact condition C37's guard exists for
(`src/codegen/async/runtime_core.yo`), and the condition
`issues/retired/compiler-build-runner-nests-event-loop.md` predicted would come
back the moment the scheduler spawned tasks again.

Outside strict mode it does not abort, and the awaited I/O here never depends on
a sibling task so it cannot deadlock — but the nested loop SERIALISES the very
scheduler the slice added to parallelise. The bug was therefore costing the
feature its point even where it looked green.

## Fix

The shape the guard's own message prescribes — poll `is_finished()` and await
`yield` — which is what `_read_stamp` / `_write_stamp` in the same file already
do:

```yo
while(runtime(_any_task_pending(handles)), {
  e.io.await(yield(e.io), e.io);
});
outs := ArrayList(Option(StepResult)).new();
(oi : usize) = usize(0);
while(oi < handles.len(), {
  outs.push(handles(oi).await(e.io));
  oi = (oi + usize(1));
});
```

Once every handle is terminal, `JoinHandle.await`'s emitted loop has a false
condition on entry and reads the result without polling. `_any_task_pending` is
a plain `fn` so the `while` condition carries no suspension point (an
`io.await` inside an `if` inside an async body is a known-fragile codegen
shape).

`join_all` is no longer imported by `src/build_runner.yo`.

## Standing lesson

`join_all`, `race`, `any` and `timeout` are top-level combinators. Inside an
`io.async` body — which always runs as a resumed continuation — the only legal
way to wait on spawned work is `is_finished()` + `await yield(io)`. Anything in
`src/` that spawns tasks must use that shape; the gate is a cli-case with
`env=YO_ASYNC_STRICT=1`, because nothing else makes the nesting visible.
