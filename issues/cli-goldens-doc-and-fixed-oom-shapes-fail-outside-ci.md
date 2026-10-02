# Six CLI goldens fail outside CI: the five `doc-*` cases and `compile-allocator-fixed-oom-shapes` (fixed)

**Severity:** S3 — local-only. Develop's CI gates are green (run 36570470718), but `gates_fast` GATE 7 is red on the WSL2/nix box for every branch.

**Status: OPEN.** Found 2026-09-30 while gating `mem/codegen-plan`.

**The six batteries were a different cause, now fixed.** The same local
`gates_fast` runs also failed six batteries (iso, rc, walker, basic, file,
async_await). Every one of those failures was a LeakSanitizer verdict, and
every CI job that runs the gates sets `YO_TEST_LEAK_VERDICT=0`: the staging
ratchet for the tracked leak debt,
`issues/self-hosted-emit-leaks-remaining-classes.md`. `gates_fast.sh` now
defaults it the same way.

## The goldens

The same box also fails six CLI goldens, identically on both sides:
- **`doc-html`, `doc-json`, `doc-logo-favicon`, `doc-markdown`,
  `doc-name-from-manifest`.** The goldens contain git's stderr from
  `yo doc`'s repository probe, `fatal: not a git repository (or any of the
  parent directories): .git`. The sandbox here sits on a mount boundary, so
  git words it `fatal: not a git repository (or any parent up to mount
  point /)` / `Stopping at filesystem boundary …`. The golden encodes
  another process's stderr. `yo doc` should not pass the probe's stderr
  through, and the goldens should not contain it.
- **`compile-allocator-fixed-oom-shapes`: FIXED 2026-10-02.** The run
  exited 1 with no stdout: the parent died with `malloc returned None (at
  std/collections/array_list.yo:270:20)`. Spawning a child that inherits the
  environment copies the whole environment into the parent's 64 KiB fixed
  heap. This box's 33 KB environment exhausted it, while 16 KB fits. The
  children now take the shape as `argv[1]` and start with `env_clear()`. The
  same change also fixed a CI-visible break in the case's `task` shape:
  `issues/fixed/oom-shapes-task-oracle-filled-the-heap-only-through-a-slot-leak.md`.

## Next step

- **`doc-*`:** `yo doc` should not pass its git probe's stderr through, and
  the goldens should be re-recorded without it.
