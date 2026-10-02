# The fixed-heap task-spawn oracle filled the heap only through a slot leak

**Severity:** S2: a safe-mode oracle (`plans/SAFE_MODE.md` §7 Phase 4 / §14 R5)
stopped exercising the path it guards. Develop's tier-1 gates went red, and
the "async task spawn under a tiny heap dies with a diagnostic" property lost
its only test.

**Status:** fixed 2026-10-02.

## What

The cli-case `compile-allocator-fixed-oom-shapes` runs three children under
`--allocator fixed --heap-size 65536`. Each must die with an allocation
diagnostic. Since #1093 the `task` child exits 0 instead. Develop CI run
36948891696 (`cae94646c`), "Self-hosted `test` subcommand (yo-self tier-1
gates)":

```
── GOLDEN-DIFF  compile-allocator-fixed-oom-shapes  (rc=0; stdout)
  < task: died with an allocation diagnostic
  ---
  > task: child exited 0 (BUG)
```

The last green develop battery was `8ac55df33`. The window
`8ac55df33..cae94646c` contains #1093: "slot ownership leaks, owning
JoinHandle step 2".

## Root cause

The fixture spawned 65,536 tasks of `io.async((io : Io) => i32(0))`. Its
comment assumed "spawned tasks do not run until the loop yields, so every
task's state stays allocated". That premise is false, and was false under the
v0.2.48 seed too. A spawned task runs eagerly until it first suspends: a probe
that spawned 1000 counter-bumping tasks read 1000 before its first yield, with
both the seed and the tree. A body that never suspends completes inside
`io.spawn`. The heap used to fill anyway, because each completed detached task
leaked its slot. #1093 fixed that leak, and the child then ran through all
65,536 spawns in constant memory.

So the oracle had been testing a leak, not task-spawn allocation. Separately,
detached tasks still run (1000 of 1000 in the probe), so #1093 did not
introduce a "freed before it ran" bug.

## Fix

Each spawned task parks on `sleep(u64(3600000))` before it returns, so its
state stays live. The heap now fills in task-spawn allocation:
`out of memory: requested 112 bytes (fixed heap 65536 bytes, live 56992 bytes
in 492 blocks)`. The golden is unchanged.

The same change also fixes the local-only failure of this case, filed in
`issues/fixed/cli-goldens-doc-and-fixed-oom-shapes-fail-outside-ci.md`. Spawning a
child that inherits the environment copies the parent's whole environment into
its 64 KiB heap. The nix box's 33 KB environment exhausted it, while 16 KB
fits. The children now get the shape as `argv[1]` and start with
`env_clear()`, and the parent passes with the full environment plus 100 KB of
padding.
