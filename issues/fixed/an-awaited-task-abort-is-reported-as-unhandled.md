# An awaited task's effect-unwind abort is reported as "unhandled", so `yo build` prints it 18 times

**Status: FIXED.** Found 2026-09-23 by develop's battery on `43e55de33`, the
v0.2.40 `SEED_VERSION` bump. Tier-1 gate 7 failed with 13 GOLDEN-DIFFs. The
twelve `context-*` ones have a separate cause, recorded in
`issues/fixed/context-goldens-pin-the-release-through-the-index-key.md`.

## The behavior (measured on the published v0.2.40 binary)

```
$ yo build run          # tests/cli-cases/task-effect-unwind-diagnostic/fixture
...
$ sort err.txt | uniq -c
     19 unhandled effect unwind aborted an async task
```

The fixture itself aborts one fire-and-forget task, so it accounts for one
line. The other **18 come from `yo build` itself**: `yo build` with no run
step prints 18, while `yo check` and `yo compile` print 0. Every user of the
v0.2.40 release sees them on every build.

## Root cause

Safe-mode 0a (#828, `issues/fixed/effect-unwind-escaping-a-task-or-main-is-silent.md`)
made the two unwind-side `state = -2` writers print the line **at abort
time**:

- `emit_async_future_escape` (`src/codegen/exprs/async_completion.yo`);
- the sync-future resume's `if (__yo_effect_escaped)` block (`src/codegen/exprs/async.yo`).

The motivating program discards its `JoinHandle`. But at abort time nobody can
know whether the task will be observed. The typed observation channel,
`JoinHandle.await` returning `.None`, comes afterwards.

`src/build_runner.yo` uses exactly that channel on purpose. A read_dir, a
read_bytes or a stamp write runs as a spawned task with a local swallow
handler that unwinds, and the spawner reads `.None` at the handle. Those
aborts are handled, yet each one printed "unhandled".

The line only appeared once the SEED carried #828. v0.2.39-built compilers
emitted no diagnostic for their own tasks, so every battery before the
`SEED_VERSION` bump was green.

## The fix: report an abort only once nobody can observe it

`emit_task_abort_registry` (`src/codegen/functions/gc_runtime.yo`) emits a
per-thread registry of unwind-aborted tasks. Chunked builds define it once,
in the chunk globals.

- **Register.** Both unwind-side -2 writers call
  `__yo_task_abort_register(sm)` instead of printing. Cancellation
  (`JoinHandle.abort()`, reached through `race`/`timeout` via
  `__yo_task_abort`) never registers.
- **Observe (silent).** Each read of the Aborted state calls
  `__yo_task_abort_observed(fut)`:
  - a sync `io.await`;
  - an async state machine's abort check, in both the uniform and the dispatch extraction;
  - `JoinHandle.await`'s `.None` branch;
  - `JoinHandle.state`/`is_finished`, through `__yo_join_handle_state_raw`;
  - `io.state`.

  An awaiter that inherits the escape is itself registered, so the
  propagation chain ends where the root is awaited.
- **Released (print).** Both state-machine dispose functions call
  `__yo_task_abort_released(ptr)`. A task whose last reference goes away
  while still registered prints the diagnostic. Because the dispose removes
  the entry before the free, every entry is a live state machine, and a
  reused address can never match a stale one.
- **Exit (print).** The main wrapper calls
  `__yo_task_abort_report_unobserved()` after the program body returns, on
  all three platform arms. A bound handle that is never awaited keeps its
  task alive, so no dispose would ever report it.

The line now says why the abort counts as unhandled: `unhandled effect unwind
aborted an async task that was never awaited`.

## Tests

- `tests/cli-cases/task-effect-unwind-observed/` covers three shapes:
  - an awaited handle, silent;
  - the build runner's shape (a task that spawns a fallible task and reads its handle), silent;
  - a bound handle never awaited, reported at exit.

  It fails before the fix: the old binary printed the abort-time line three
  times, with none of the exit report.
- `tests/cli-cases/task-effect-unwind-diagnostic/` covers the fire-and-forget
  task, still exactly one line.

Both patterns match the new wording. **Seed lag:** until the seed carries
this fix, the self-hosted binary under test is built by a v0.2.40 seed, so
its own build-runner tasks still print the OLD abort-time line. Those lines
fail to match the new pattern, so they are not scored as the program's
output.

**Follow-up once the seed carries the fix:** add a case asserting that `yo
build` prints no unwind diagnostic at all. Today it would measure the seed's
codegen, not this tree's.
