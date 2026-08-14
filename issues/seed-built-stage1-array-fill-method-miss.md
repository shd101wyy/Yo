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

## Scribble results (2026-08-14, later)

Seed-built stage-1 **with libc allocator** under
`MallocScribble=1 MallocPreScribble=1`: **154/154 clean** on macOS (as was
the TS-built binary). This EXCLUDES the universal-early-free theory (a
read-after-free that executes on macOS would read 0x55 poison and fail) and
the uninitialized-read theory (PreScribble poisons fresh allocations). The
defective code path therefore EXECUTES ONLY ON LINUX. Prime suspect: the
Linux-specific runtime chunks the check workload exercises — the io_uring
async-IO path in compiled std (macOS runs kqueue) corrupting evaluator heap
workload-dependently, or a Linux-target-conditional emission difference in
the v0.2.4 seed.

Diagnostic workflow armed: `debug-gate3.yml` on branch
`debug/gate3-array-fill` (at the failing commit e0bb8f5a3) — single-file
scoping, within-binary determinism ×2, GC on/off discriminator, an
allocator-swap run, valgrind memcheck on the smallest failing unit, and the
seed-emitted stage-1 C uploaded for offline diffing against the macOS
emission. Delete the branch when this issue closes.

## VALGRIND LOCALIZATION (2026-08-14, debug-gate3 run 1)

The `debug-gate3` workflow (branch `debug/gate3-array-fill`) delivered:

| diag                                | result                                                             |
| ----------------------------------- | ------------------------------------------------------------------ |
| md5 single-file (mimalloc stage-1)  | **PASSES** — needs full-run context                                |
| full `check ./std` ×2               | 152/154 both — within-binary deterministic                         |
| `YO_GC_THRESHOLD=0` full            | 152/154 — **NOT the cycle collector**                              |
| libc-allocator stage-1 full         | 152/154 — **not allocator-specific**                               |
| valgrind (libc stage-1, full ./std) | **rc=99: 2,232,810 uninitialised-value errors from 1000 contexts** |

The resolvable origins all point at ONE creation site: the **statx buffer
malloc** in `std/fs/file.yo`'s `exists`/`is_file`/`is_dir` async blocks
(`buf := *(u8)(malloc(__yo_statx_buf_size()).unwrap())`, file.yo:328-330 —
the emitted `_file____home_temp_*_resume` state 0). In state 1 the emitted
C reads **`sm->await_future_0->result` as an uninitialised value** — the
statx completion either never wrote the future's result or the branch on
`result < 0` runs before/without it, after which the (kernel-unfilled)
buffer's contents are read. The taint then propagates (valgrind
origin-tracking) through the lexer (`tokenize(input, module_path)`), expr
predicates (`ast_expr_is_fn_call_of` — the top read site, 169 contexts),
`evaluate_variable`, and `bcmp` — i.e. into String hashes/compares inside
the evaluator's registries, which is exactly the mechanism that turns into
a nondeterministic method-miss downstream.

Linux-only by construction: this whole statx path exists only on the
io_uring side; macOS runs kqueue/stat.

Refinements from the full log: **zero `Invalid read/write` reports** — every
flagged access is to allocated-but-unwritten memory, and the seed-emitted
`__yo_async_statx_start` is byte-identical to the current template (future
malloc'd + memset(0) + full field init, so the future is NOT
created-uninitialized). The two mechanisms consistent with that:
(a) the future is **freed early** (refcount bug in the emitted async
machinery) and its slot re-malloc'd as the next statx buffer before the
dangling `->result` read — recycled-not-yet-written memory reads as
"uninitialised", never as "invalid"; or (b) the io_uring **completion does
not fill what the code believes is filled** (CQE→future routing / unfilled
statx fields despite rc>=0), so `exists`/`is_file` compute their bool from
kernel-unfilled buffer bytes (the top-level trace: the uninit bool is
branched on by the check driver itself, origin = the statx-buf malloc).

**Discriminator (run 2, in flight): the same tree TS-built on Linux, same
check + valgrind.** Clean → the defect is v0.2.4 SEED CODEGEN (historical;
fixed by advancing the seed to v0.2.5 once #122-#124 merge and release).
Dirty → a live std/codegen bug to fix in both compilers now.

## Discriminator results (debug-gate3 run 2) + a valgrind caveat

**TS-built stage-1 of the same tree, on Linux: `check ./std` = 154/154
PASSES** — while its valgrind run reports 2.56M "uninitialised" errors of
the same shape as the seed arm. That parity of valgrind noise across a
passing and a failing binary exposed a reading error in the localization
above: **valgrind memcheck cannot see io_uring completions** (the kernel
fills buffers with no syscall boundary memcheck hooks), so buffers the
kernel legitimately filled still read as "uninitialised". Most of the 2.2M
reports are this blindness, NOT the defect. What remains true and proven:

- Current codegen produces healthy Linux binaries: the TS-built stage-1
  passes GATE 3; the 188-file hollow sweep (stage-1-EMITTED binaries =
  current yo-self codegen) is green; the fixpoint holds.
- The v0.2.4-EMITTED stage-1 misbehaves, timing/layout-dependently, in the
  async-IO-driven paths (the flagged branch sits in `collect_check_files`
  consuming `is_file`/`is_dir` results).

Best-fit defect class: a v0.2.4 async **await-result handling** bug — the
same machinery where the tail-await result-loss was found and fixed in the
current tree (both compilers). It only bites when an await actually
SUSPENDS: the emitted inline fast-path (`__yo_inline_budget`) hides it
whenever IO completes synchronously — which is why macOS (kqueue, more
sync completions) never shows it, and why unrelated source shifts flip the
outcome (latency lottery around the suspend window). No standalone
tail-await shape exists in current std/yo-self sources, so v0.2.4's bug
class is broader than the fixed shape — the exact v0.2.4 defect is
unrecoverable-by-inspection without its era's codegen, and it is
**immutable in a shipped release artifact**.

Run 3 result: the **v0.2.3-seed stage-1 fails identically** (152/154 ×2) —
the defect predates v0.2.4; there is NO healthy release seed to roll back
to. The release line's async codegen carried this class at least since
v0.2.3.

Run 4 (in flight) tests the resolution's load-bearing premise: the TS pass
only proves the TS emitter, but v0.2.5-as-seed will be YO-SELF-emitted —
so run 4 builds STAGE-2 (stage-1-emitted main.yo = current yo-self
codegen's output) on Linux and runs GATE 3 under it. Pass = the resolution
is sound; fail = a LIVE yo-self codegen bug to fix now.

## Resolution path

The defect lives in the v0.2.4 release binary's codegen, not in the
current tree (both current compilers' Linux output is verified healthy).
The fix is the trust chain working as designed: merge the open stack, cut
v0.2.5 (whose codegen carries the async result-storage fixes), bump
`SEED_VERSION` — the defective emitter leaves the chain. Until then the
tier-1 job's GATE 3 fails on the v0.2.4-built stage-1; that failure is
attributable to the RETIRED seed, not to the PRs' content.

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
