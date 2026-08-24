# ~~S1 prelude growth tripled self-emit memory~~ — SUPERSEDED: the regression was a debug-probe line, NOT std growth

**Status: SUPERSEDED 2026-08-24 (same day)** by
issues/debug-probe-line-costs-gigabytes-at-compile-time.md.

The bisect this doc originally recorded was CONFOUNDED twice:

1. The 10.0 GB "pre-#238 baseline" was measured in a worktree with EMPTY
   `vendor/` submodules (the fresh-worktree trap) — the true with-vendor
   baseline is **17.1 GB**, so the "S0/chunk-1 jump" never existed.
2. The real +11.7 GB / +2.9x wall jump came from #242's 5-line `[bind-T]`
   DEBUG-PROBE enrichment in src/evaluator/types/synthesizer.yo — a
   compile-time cost of the probe's own code (it never fires), proven by a
   2x2 over #242's two src files. The S0+S1 std campaign in its entirety
   costs +0.4 GB (17.1 -> 17.5 GB).

Consequences carried forward:

- The probe revert restores normal CI shard times; **revert #244's budget
  patch** (shard `timeout-minutes` 210 -> 120, drop
  `--compile-timeout-ms 1800000`) once verified.
- std growth is NOT gated on the env-sharing campaign after all — that
  campaign remains a real (pre-existing) improvement track, not a blocker.
- The measurement discipline lives in the superseding issue: always init
  vendor/ submodules and use peak footprint on with-vendor trees.
