# RESOLVED (not a regression): the self-emit "drift" since r16 is 100% input growth

**Status:** attribution COMPLETE 2026-08-17 — the compiler-regression hypothesis
is REFUTED by a 2×2 matrix; the compiler is ~1.6-1.7× FASTER than r16's.
Snapshot retired; the remaining actionable fact is that the yo-self TREE's
instantiation load is what drives the step-24 memory blocker.

## The matrix (Mac Mini M4, `compile yo-self/main.yo --release --emit-c --skip-c-compiler`, `/usr/bin/time -l`)

Binaries are both TS-built stage-1 (like-for-like): "r16 binary" from
`4c10894cb` (PR #76 squash — the bootstrap/memory-campaign state), "today
binary" from the PR #133 tree (env-sharing included).

|                  | r16 tree (4c10894cb) | today tree (PR #133) |
| ---------------- | -------------------- | -------------------- |
| **r16 binary**   | 150.4 s / 9.35 GB    | 432.5 s / 14.28 GB   |
| **today binary** | **92.8 s / 7.76 GB** | 232-283 s / 12.21 GB |

- **Columns (fixed tree, swap binary): the compiler IMPROVED.** On the r16
  tree: 150 → 93 s (1.62×), 9.35 → 7.76 GB (−1.6 GB). On today's tree:
  433 → ~250 s (1.7×), 14.28 → 12.21 GB (−2.1 GB). The correctness wave +
  env-sharing NET improved both wall and footprint.
- **Rows (fixed binary, swap tree): the INPUT got ~2.7× heavier.** Under
  today's binary: 93 → ~250 s, 7.76 → 12.21 GB (+4.4 GB). Line count grew
  only +14% (yo-self 175,448 → 199,974; std flat), so the P1/P2 ports
  (build_runner, version_cache, fetch/install, doc pipeline, module_manager,
  main.yo's CLI surface) are disproportionately instantiation-heavy per line.

## Why the recorded 98.7 s r16 baseline reads lower than cell A's 150 s

The plans/backlog/YO_SELF_ENV_SHARING.md table's 98.73 s was almost certainly
measured with a SELF-BUILT stage-2 binary (that era's records note the s2 emit
being much faster than the TS-built stage-1), while this matrix deliberately
uses TS-built stage-1 binaries on both sides for a like-for-like comparison.
Footprint reproduces (9.08 recorded vs 9.35 measured), which is the number the
step-24 blocker cares about.

## What remains actionable

- **Step 24 (seed-bundles flip)**: the 12.2 GB self-emit footprint is
  INPUT-driven. Compiler-side levers are largely spent (env-sharing landed;
  the capture-env memo family is refuted — see
  `plans/backlog/YO_SELF_ENV_SHARING.md`). Remaining directions: reduce the
  instantiation load of the ported modules (generic dedup at the SOURCE
  level), a compiler-side instantiation-dedup/interning pass, or the step-24
  options A/C (cross-emit fan-out / bigger runners) recorded in
  `plans/archive/P2_5_RETIRE_EXECUTION.md`.
- Per-module cost attribution (which ported modules dominate the +4.4 GB)
  would target source-level dedup work; measurable by emitting subsets of
  main.yo's import closure.

## Addendum: per-module attribution (2026-08-17, today binary × today tree)

`check <root>` footprint per import-closure root (evaluator + def-evals, no
emission):

| root                 | wall  | peak        |
| -------------------- | ----- | ----------- |
| parser.yo            | 1.5 s | 0.37 GB     |
| env.yo               | 26 s  | 1.64 GB     |
| codegen/codegen_c.yo | 44 s  | 1.76 GB     |
| module_manager.yo    | 53 s  | 1.83 GB     |
| build_runner.yo      | 104 s | 1.83 GB     |
| fetch_command.yo     | 53 s  | 1.86 GB     |
| install_command.yo   | 31 s  | 1.89 GB     |
| doc_command.yo       | 105 s | 1.96 GB     |
| **main.yo (FULL)**   | 124 s | **1.89 GB** |

The FULL check closure peaks at 1.89 GB while the emit peaks at 12.21 GB —
**~85% of the self-emit footprint is EMISSION-PHASE**: per-call-site
specialization evaluation, the specialization-driven ExprInfoTable, and
codegen structures. No single module's def-eval closure is heavy, so
source-level per-module dedup is NOT the lever; the step-24 memory work, if
resumed, must census the emission phase (what the specialization machinery
retains per instantiation — building on plans/archive/YO_SELF_EXPRINFO_PRUNE.md's
rejected prune and the §4a census in plans/backlog/YO_SELF_ENV_SHARING.md).

## Addendum 2: allocator A/B on macOS (2026-08-17) — no lever

A libc-allocator build of the same tree emits at 262 s / **12.22 GB** vs the
mimalloc build's 232-283 s / 12.21-12.25 GB: identical footprint, wall within
noise. The r15-era "mimalloc slower & fatter on Mac" finding does not
reproduce on the post-env-sharing workload. The remaining sub-7 GB levers are
the 56 B RC-header shrink (~2-3 GB ceiling over ~53 M objects) and the
emission-phase census — both P3-era campaigns; neither gates P2 (the macOS
release legs are cross-emitted per step-24 option A).
