# `Array(T, N).fill` method-miss in std/crypto/{md5,sha256}: double prelude evaluation + readdir-order dependence (BOTH compilers)

**Status: FIXED + MERGED 2026-08-15** (develop squash 41c2d9d96 via PR #122; CI green including the GATE 3 tier-1 job that surfaced it)

**Originally filed as:** (found on
PR #122 round-5 CI, run 31753265776; the title's original "seed-built
stage-1 / layout-sensitive" framing is preserved below as the investigation
record — it was a mirage). Fix record at the end of the FIX section below.

## ROOT CAUSE (the short version)

1. `run_check` pre-loads the prelude under the path string
   `./std/prelude.yo`; the directory walker later checks `std/prelude.yo`.
   The module cache keys on the raw path string → miss → **the prelude is
   evaluated TWICE** whenever `std/prelude.yo` is inside the checked tree.
2. The second prelude evaluation corrupts where-constrained generic-impl
   resolution for files checked AFTER it: the first file needing a fresh
   `Array(T, N)` specialization (`md5`/`sha256`, the where(T <: Comptime)
   `fill` impl) reports "No matching call found". (Deep mechanism to pin
   during the fix: duplicate registration under re-minted prelude type
   identities colliding in the process-wide impl registries.)
3. Whether prelude-as-file runs BEFORE the crypto files depends on RAW
   READDIR ORDER (`collect_check_files` does not sort): ext4 hash order
   usually walks it first (→ CI failures), APFS after (→ macOS immunity),
   and ext4's per-directory hash seed differs per fresh checkout (→ the
   "lottery" — runs 31778789281 and round 2 drew a passing order).

**Both compilers fail under the forced order on macOS** (TS node CLI: 1/3
passed; current yo-self-built binary: identical 2 errors) — this is a
SHARED evaluator/module-manager logic bug, not codegen, not the seed, not
Linux, not io_uring.

Minimal repro (any platform, any binary):

```
cp -R std /tmp/ot/std && mv /tmp/ot/std/crypto /tmp/ot/std/zzcrypto   # force walk order
cd /tmp/ot && yo check ./std --exclude <everything but prelude.yo, zzcrypto/{md5,sha256}.yo>
# → prelude checked twice (pre-load + as-file), then md5/sha256 fail .fill
```

## Fix plan (all three are real defects; no workarounds)

1. Canonicalize module-cache keys (absolute, normalized) in BOTH module
   managers so the pre-load and walker share one entry — kills the double
   evaluation.
2. Root-cause and fix the registry collision so a re-evaluated prelude is
   harmless anyway (idempotent registration or identity-stable lookup).
3. Sort `collect_check_files` (and TS's walker) so check order is
   deterministic cross-filesystem.

## FIX (2026-08-14)

The per-compiler mechanisms turned out to differ in detail; both are fixed
at the source:

**TS.** The walker already sorts (`collectCheckFiles`, src/yo-cli.ts:76),
and the module cache was already keyed near-canonically — `check` keys the
top-level file by `"file://" + fs.realpathSync(file)` (yo-cli.ts:594) but
the evaluator keys the implicit prelude by `"file://" +
path.join(stdPath, "prelude.yo")` (src/evaluator/index.ts:132). The two
spellings diverge whenever the std root is reached through a symlink
(macOS `/tmp` → `/private/tmp`) or a non-normalized `--std-path` — then the
prelude loads twice and the SECOND load dies loudly on TS's duplicate-
method check. Fix: `canonicalizeModulePath` (resolve + realpath, falling
back to resolve for not-yet-on-disk inputString loads) applied at the
`loadModule` / `deleteModule` / `compileModule` entry points of
`ModuleManager`. Canonical keys also repair TS's designed idempotence for
re-evaluated impls: the replace-if-same-`sourceModulePath` path
(impl.ts:2871-2881) only recognizes "same module" when both spellings
canonicalize to one string.

Red-first proof (same probe, `--std-path /tmp/ot/std` through the `/tmp`
symlink spelling): pre-fix `check: 1/3 file(s) passed` with
`Method "len" is already defined for type "comptime_str"`; post-fix 3/3.

**yo-self.** The module cache never held the prelude at all
(`_load_module_at_abs` early-returns on `prelude.yo`); the prelude exists
only as the cached cloned env. `mm_load_file`'s prelude branch called
`mm_load_prelude_file`, which re-evaluated the prelude BODY unconditionally
— only the env store was populate-once. So pre-load + walker-hit = two full
prelude evaluations into the process-wide impl registries, and yo-self
(unlike TS) has NO duplicate-registration checks, so the corruption is
silent until the first fresh `Array(T,N)` specialization fails (see
issues/yo-self-missing-duplicate-impl-checks.md for that parity gap). Fix:
evaluation-level populate-once — `mm_load_file` now returns a cached-hit
outcome for any `prelude.yo` target once `g_cached_prelude_env` is set
(mirrors a TS module-cache hit). Plus `collect_check_files` now sorts
(`out.sort()`, main.yo) — its docstring had always CLAIMED sorted output;
the sort was never implemented, which is what made ext4's per-checkout
readdir hash order a verdict lottery.

Item 2 (registry collision) resolved as: TS already has the designed
idempotence + loud-reject (repaired by canonical keys); yo-self's missing
checks are filed as issues/yo-self-missing-duplicate-impl-checks.md — with
both double-evaluation sources closed, no shipped path re-registers today.

---

# Investigation record (original framing below — historical)

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

## ~~Resolution path~~ REFUTED by run 5

Run 5 (the fixpoint job's exact stage-1/2 recipe): **STAGE-2 — current
yo-self codegen's own emission of the compiler — FAILS GATE 3 identically
(152/154 ×2, md5+sha256)**. The "advance the seed" resolution is dead:
every yo-self-emitted compiler fails this workload on Linux (v0.2.3,
v0.2.4, and current), while the TS-emitted compiler of the same sources
passes. This is a **LIVE yo-self codegen divergence from TS** in the
async/IO machinery — precisely the class the two-compiler differential
exists to catch, hiding until now because (a) no yo-self-emitted compiler
ever ran `check ./std` on Linux before the CI migration made the tier-1
job seed-driven, and (b) the failure needs the workload's timing (the
suspend-window lottery — the same binary passed tier-1 on run 31778789281
and failed on 31753265776).

Why the existing gates missed it: the fixpoint compares stage-2 ≡ stage-3
BYTES (both emitted by yo-self codegen — a shared divergence cancels); the
hollow sweep runs 188 SMALL test binaries (insufficient async/IO pressure);
GATE 2's corpus compares runnable programs' behavior (again small); and
`check ./std` under a yo-self-EMITTED binary was never a CI workload until
days ago.

## Actual resolution: find + fix the emission divergence

Method (the [[optimizer-change-emit-diff-gate]] approach): cross-emit a
probe exercising the `exists`/`is_file` async path for
`--target x86_64-linux-gnu` with BOTH current compilers on macOS, then
structurally diff the async state machines (resume states, await-result
storage, future RC ops, event-loop interaction) and the per-function
dup/drop counts. The divergence is the bug; fix yo-self codegen; pin with
a differential case.

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
