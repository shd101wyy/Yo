# The compiler's own build scheduler drives spawned tasks that call plain awaiting helpers — the nested-event-loop guard (C37) cannot be armed by default until this is refactored

**Found**: 2026-08-28, the moment C37's runtime guard first ran in CI: the
"Build system smoke test" (`yo init` + `yo build run` with the stage-1 binary)
aborted with

```
panic: a blocking await ran inside an async task: an io.await in a non-io.async
function, JoinHandle.await, or a std/async combinator (join_all/race/any/timeout)
was called from a spawned or awaited task. …
```

**Status**: OPEN. The guard is therefore armed by `YO_ASYNC_STRICT=1` only;
`yo test` sets it for every test child (so `tests/` is enforced — the whole
suite passes strict), and ordinary programs, including the compiler itself,
stay relaxed.

## The sites

`src/build_runner.yo`'s level-based DAG scheduler and `src/main.yo`'s
`_compile_chunks_parallel` spawn tasks (`io.spawn`) whose bodies call plain
helpers that await synchronously — each such call is a nested
`__yo_async_poll_step` loop inside a task:

- `src/build_runner.yo`: `_cache_collect_yo_files`, `_cache_read_file`,
  `_git_version`, `_read_stamp`, `_write_stamp`
- `src/main.yo`: `_chunk_read`, `_chunk_write_stamp`, the helpers reached from
  `_compile_chunks_parallel`, `_check_compiler_available`, `_probe_*`
- possibly `src/check_watch.yo` (`_stat_key`, `wait_for_change`) and
  `src/doc_command.yo` when those run under a spawned task

(Full list of plain-fn await sites in `src/`: the scan in the C37 landing PR;
most are called from `main`'s synchronous path and are fine — only the ones
reached from a spawned task matter.)

## Why they have not deadlocked

Their awaited I/O (file reads, stamp writes, child processes) never depends on
a sibling task, so the nested loop always drains. The cost is only lost
parallelism (the nested loop serialises the scheduler while it waits) and the
latent hazard the guard exists for.

## What to do

Make the helpers `io.async` futures and `await` them from the task bodies (the
same change #333 made to `std/http`'s `_read_http_response`), then flip the
guard's default to armed and delete the env var. Measure with the smoke test
(`yo init` + `yo build run`), `yo build` of the repo itself, `yo doc`, and the
cli-diff corpus — the guard turns every remaining site into a deterministic
abort, so the sweep is self-verifying.
