# Await nested in if-branches inside io.async lost its continuation (observed once, not yet minimized)

**Status: RETIRED** (2026-09-30), because it cannot be reproduced. Re-verified 2026-09-30 against develop `29bf728b4` and the v0.2.46 seed:
- `probe1` and a corrected `probe2` print steps 1–6 on both.
- A fuller reconstruction of #213's `compile_artifact` shape also runs correctly on both. It has awaits around the outer `if`, a helper that awaits through a recursive helper with a per-call Exception handler and an early `return` in a while, and a nested `if(stamp.len() > 0)` that awaits.

The failing version existed only on a squash-merged branch, and #1018 replaced the lowering it ran through.

**Severity:** S1 — a nested-if await compiled silently wrong — branch statements never executed, no diagnostic

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

## Re-verified 2026-09-28 (async state-machine audit)

Tree build of develop `af62bdb28`, and the v0.2.45 seed unless noted. See `plans/ASYNC_STATE_MACHINE_GENERATION.md` §3.3.

**CANNOT REPRODUCE.** The described shape was rebuilt: a recursive plain helper that awaits internally, an outer `if` assigning `stamp`, then a nested `if` with an await. It prints `inner branch ran … hits=1`, which is correct. Without the original code this cannot go further. Candidate for `retired/` if nothing turns up by the next audit.

## Re-verified 2026-09-29 (async state-machine plan phase 5)

The segment lowering this was observed under is deleted: an `io.async` body
is now emitted once, through the ordinary expression generators
(`plans/ASYNC_STATE_MACHINE_GENERATION.md` phase 5). A reconstructed minimal
shape passes both on the v0.2.45 seed and on the single-pass lowering, so
there is still no reproducer. Left open until one is distilled from a real
failure; if you meet it again, file the reproducer rather than rewriting
around it.

## Retired 2026-10-01: resolved wholesale by the single-pass lowering

**Measured** (v0.2.47 seed). This third reconstruction adds the ingredients
the two probes above left out:
- the stamp helper is a plain function that blocking-awaits inside the task;
- it recurses through `read_dir` with a per-call `Exception` handler that
  `unwind`s, exercised on a missing directory;
- the closure awaits `create_dir_all` and two child-process `status` calls
  around the branch;
- the nested `if (stamp.len() > 0)` awaits `exists`.

It prints `inner branch ran, exists=true`, a 3,397-byte stamp and
`result 1`, all correct.

The original failing code was never committed: #213's PR ref holds only the
rewritten version. So no closer reproduction exists. The segment lowering it
was seen under is deleted (`plans/ASYNC_STATE_MACHINE_GENERATION.md`
phase 5), and every await shape around it is tested in
`tests/async/sm_shapes_*`. That makes this a record of a lowering that no
longer exists, not an open bug. If the symptom appears again, file the
reproducer as a new issue.
