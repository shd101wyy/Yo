# Six CLI goldens fail outside CI: the five `doc-*` cases and `compile-allocator-fixed-oom-shapes`

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
- **`compile-allocator-fixed-oom-shapes`.** The run exits 1 with no stdout;
  the golden expects rc 0 and three `…: died with an allocation diagnostic`
  lines. Not yet diagnosed.

## Next step

- **`doc-*`:** `yo doc` should not pass its git probe's stderr through, and
  the goldens should be re-recorded without it.
- **`compile-allocator-fixed-oom-shapes`:** diagnose the rc=1 with no output
  on this box.
