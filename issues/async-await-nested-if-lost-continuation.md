# Await nested in if-branches inside io.async lost its continuation (observed once, not yet minimized)

**Found:** 2026-08-22, implementing the build-artifact cache in
`src/build_runner.yo`'s `compile_artifact` (an `io.async` closure that
already contains several awaits: `create_dir_all`, `_git_version`'s
helpers, `cmd.status`).

## Observed

The first cache implementation had this shape inside the closure:

```rust
(stamp : String) = String.new();
if(cache_enabled, {
  stamp = _artifact_input_stamp(cmd._args, ctx.project_dir.clone(), e.io);
  //      ^ a PLAIN (non-async) fn that awaits internally, incl. through a
  //        RECURSIVE helper (_cache_collect_yo_files) and per-call
  //        Exception handlers
  if(stamp.len() > usize(0), {
    out_exists := e.io.await(exists(...), e.io);
    eprintln(...);          // <- NEVER PRINTED
    ...cache-skip logic...  // <- NEVER RAN
  });
});
// execution RESUMED here normally; the build completed rc=0
```

Instrumentation showed `_artifact_input_stamp` ran to completion (its last
internal probe printed, hashing ~18 KB) — yet no statement inside
`if(stamp.len() > usize(0))` ever executed, on every run, while everything
after the outer `if` behaved normally. Either the helper's return value was
lost through the async state machine (leaving `stamp` empty) or the nested
branch containing the await was mis-lowered.

## What it is NOT (two minimal probes both PASS)

- A plain await nested two ifs deep inside `io.async`
  (`issues/repros/` — `probe_nested_await.yo` shape): all steps print.
- An await-bearing PLAIN helper called in a branch, its result assigned to
  a pre-declared state-machine variable, followed by a nested await
  (`probe_nested_await2.yo` shape): all steps print.

So the trigger needs something from the real context — candidate
ingredients not yet isolated: the closure's OTHER awaits before/after, the
helper recursion depth, the `cond(...)` value position, or the number of
state-machine variables.

## Workaround (landed with the cache)

Hoist every await-bearing step to a TOP-LEVEL statement of the async
closure and reduce the branch to a pure-boolean decision:

```rust
stamp := cond(cache_enabled => _artifact_input_stamp(...), true => String.new());
out_exists := e.io.await(exists(...), e.io);
prev_stamp := _read_stamp(...);
use_cache := (((cache_enabled && (stamp.len() > usize(0))) && out_exists) && stamp_matches);
if(use_cache, { ...skip... });
```

This shape works deterministically (cache hit/miss/invalidation all
verified).

## Why this matters beyond the cache

`check` is evaluator-only and the async state-machine restrictions live in
codegen — SOME shapes are rejected there ("`io.await` in a cond condition
must BE the first condition"), but this one compiled SILENTLY WRONG. Until
minimized and fixed, treat "await only at async-closure statement level"
as the safe authoring rule (added to the syntax cheatsheet), and distill
the reproducer by bisecting compile_artifact's context down (the failing
version is preserved in this branch's history —
`git log -p src/build_runner.yo` around the cache commits).
