# Seed-built stage-1: `Array(T, N).fill` method-miss in std/crypto/{md5,sha256} (Linux CI, layout-sensitive)

**Status: OPEN** (found 2026-08-14, PR #122 round-5 CI, run 31753265776).

## Symptom

`check ./std` under the **seed-built** stage-1 (v0.2.4 seed → `yo compile
yo-self/main.yo --release --allocator mimalloc`, ubuntu-latest) reports
152/154:

```
check: error in: Error: No matching call found with arguments:
(Array(u8, usize(128)).fill)(u8(0))     std/crypto/md5.yo:212:35
(Array(u32, usize(64)).fill)(u32(0))    std/crypto/sha256.yo:94:29
```

`fill` is registered by the prelude's where-constrained generic impl
(`std/prelude.yo:5608`: `impl(generic(T : Type, U : usize), where(T <: Comptime),
Array(T, U), fill : ...)`).

## Why this is NOT a simple regression

- The **same binary** in the same run passed GATE 4 (`check ./yo-self`,
  247/247 — far heavier files), GATE 2 (155-file corpus differential),
  GATE 1 (the tier-1 test battery) and GATE 7 (32 CLI cases). Only these
  2 files fail.
- `std/crypto/random.yo` — checked immediately AFTER sha256 in the same
  process — uses the **identical construct** (`Array(u8, usize(16)).fill(u8(0))`,
  `Array(u8, usize(4)).fill(...)`) and PASSES. So the impl is resolvable in
  the same process before and after the failures.
- Round 2 of the same PR (tip 70f7d42ca) passed GATE 3 **154/154** on the
  same platform with the same seed. The tree diff 70f7d42ca..e0bb8f5a3
  touches only `yo-self/codegen/exprs/drop_dup.yo` (+30, the Future
  drop/dup arms), `yo-self/main.yo` (+22, leak-verdict env staging),
  test.yml and an issue doc — **no evaluator source changed**. The
  stage-1's evaluator is byte-identical in source between the passing and
  failing rounds.
- Local TS-built binaries (same yo-self sources) pass `check ./std`
  154/154 repeatedly on macOS, including single-file checks of md5 under
  `YO_GC_THRESHOLD=1` (max-aggressive cycle collection).

Conclusion: a **latent, layout-sensitive defect** — either in the
seed-built stage-1 binary (v0.2.4 miscompilation of current yo-self
sources) or a memory/rooting bug in the evaluator that only manifests
under that build's allocation layout — surfaced by the +52-line source
shift, not caused by its content.

## What distinguishes the two failing files

Both build multiple constructor-form Array specializations (64-entry
constant tables: md5 `_T`/`_S` at :18/:84, sha256 `_K` at :17) before
their first `.fill` call. The passing `.fill` users (random.yo, net/tcp.yo,
fmt/to_string.yo) do not. A distilled probe (two 64-entry
`Array(u32, usize(64))(...)` tables + `Array(u8, usize(128)).fill`) does
NOT reproduce under the TS-built binary (default GC or `YO_GC_THRESHOLD=1`).

## Repro attempts so far

| attempt                                                                  | binary                | platform | result                                                                      |
| ------------------------------------------------------------------------ | --------------------- | -------- | --------------------------------------------------------------------------- |
| CI round 5 GATE 3                                                        | seed-built (mimalloc) | ubuntu   | **152/154 (the failure)**                                                   |
| CI round 2 GATE 3                                                        | seed-built (mimalloc) | ubuntu   | 154/154                                                                     |
| `check ./std` ×several                                                   | TS-built (libc)       | macOS    | 154/154                                                                     |
| md5 single file, `YO_GC_THRESHOLD=1`                                     | TS-built              | macOS    | OK                                                                          |
| distilled table+fill probe, both GC modes                                | TS-built              | macOS    | OK                                                                          |
| CI rerun of the failed job (same commit, fresh seed build)               | seed-built            | ubuntu   | **152/154 — identical failure** (md5:212, sha256:94, byte-identical errors) |
| seed-built stage-1 (v0.2.4 + mimalloc, e0bb8f5a3 worktree) `check ./std` | seed-built            | macOS    | **154/154 ×6** (no repro)                                                   |

## Analysis addendum (2026-08-14, after the rerun)

The rerun reproduced **byte-identically** on Linux. Combined with the
fixpoint (emission is deterministic: same tree → same stage-1 binary), this
is "deterministic per tree" — which is exactly what the layout-lottery
theory predicts, NOT evidence against it. Note `check` never EXECUTES the
drop_dup code that changed in the failure window: those +30 lines are
codegen-module dead weight on the evaluator path, so they can only matter
through binary layout.

Working theory (fits every observation): an evaluator value involved in
where-constrained generic-impl matching (the specialized method entry, its
env, or a type-key intermediary) is **freed early** (RC or GC-rooting bug)
on ALL platforms. macOS reads the stale-but-intact memory and "works";
Linux's allocator recycles the slot before the lookup — md5/sha256 are the
files that allocate the most (64-entry comptime tables) between the free
and the `.fill` lookup, so they are the recyclers. This is the
MallocScribble-detectable class ([[rc-probes-scribble-and-rc]]).

## Next steps

1. If the macOS seed-built stage-1 reproduces → iterate locally
   (single-file, distilled probe, `YO_GC_THRESHOLD` sweep, MallocScribble).
2. If the CI rerun greens → confirmed nondeterministic (build- or
   run-level); instrument the where-constraint/impl-matching path
   (`yo-self/evaluator/values/type_trait_methods.yo`,
   `evaluator/env.yo` generic-impl matching) with a diagnostic print on
   the miss, and land the probe behind an env flag so the next CI
   occurrence self-describes.
3. Check v0.2.5's release timing: once #122+#123 merge and a release
   cuts, the seed advances and the layout reshuffles — do NOT let that
   mask this issue; keep the repro tree (`/tmp/wt122` = e0bb8f5a3).
