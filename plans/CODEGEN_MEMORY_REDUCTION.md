# Codegen memory reduction — audit and implementation plan

**Status: ACTIVE, opened 2026-09-29.** This picks up where
[`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md) paused (§8
there). That campaign cut what `check` retains to 970 MB. This one covers what
`compile` holds on top of it: the evaluator state kept alive for codegen, and
codegen's own working set. Phase 0's instruments are in (§0.1–§0.3); landed
levers: lazy `HashMap` (§0.4) and copy-on-write frame lists (§0.5),
`compile` 3,284 → 2,992 MB on mimalloc.

Prior art: [`archive/BUILD_ON_8GB_MACHINES.md`](archive/BUILD_ON_8GB_MACHINES.md),
closed 2026-09-26. It found that compile's excess over `check` was the shared
`ExprInfoTable`, not codegen, and dropped executed CTFE clones from it
(−1.56 GB). Its residual, the call-overload trial clones (176 MB), is still
open here.

## 0. Baseline (measured 2026-09-29)

Stage-2 compiler built from develop `af62bdb28` (mimalloc, `--optimize 2`),
`compile src/main.yo --skip-c-compiler --emit-c --profile`, with RSS sampled
every 0.5 s from `/proc`:

| phase (`--profile`) | wall | RSS at the end of the phase |
| --- | --- | --- |
| prelude + parse | 1.4 s | — |
| entry module evaluation | 171 s | ≈ 2.65 GB |
| codegen: collect | 22 s | ≈ 2.85 GB |
| codegen: emit | 149 s | ≈ 3.07 GB, **peak 3.25 GB at 343 s** |
| write C | 0.2 s | — |

The same compiler peaks at **0.97 GB on `check src/main.yo`**. So:

- **≈ 1.7 GB is evaluator state that `compile` keeps and `check` does not.**
  In `compile`, every module writes its per-expression metadata into one
  process-lifetime table (`g_shared_expr_info_table`,
  `src/module_manager.yo`), so codegen can read any function's metadata. In
  `check`, each module's table dies with the module's walk. The codegen-only
  side tables (`set_codegen_tables_enabled`, evaluator plan §0.21) are also
  on only in `compile`.
- **≈ 0.6 GB is codegen's own increment** (collect + emit).

The CI ratchets (`scripts/bootstrap/memory-ratchet.tsv`):
- `compile_src_main_peak_kb` = 3,527,328 kB, the cgroup peak of
  `compile src/main.yo` including the C compiler under an 8 GB no-swap limit;
- `check_src_main_max_rss_kb` = 1,071,836 kB.

Leads from an exit holder census of `compile`. It was taken at teardown,
after the shared table was released, so these are not peak attributions:
- `g_emission_occurrence` holds 477,813 entries;
- `g_method_callee_values` and `g_method_callee_types` hold 126 K and 120 K
  entries (evaluator-written, codegen-read);
- 38,494 `Pattern` objects are unreachable, with as many external references
  (`R 38488 38488 Pattern`). That is either a leak or a census blind spot for
  `ArrayList(Arm)` element buffers, and step 0.4 settles it.

### 0.1 Phase 0 step 1 in use (2026-09-29)

`--profile` now prints `profile: memory <phase> rss=…MB table=…` (step 1).
Stage-2 of this branch (`dda139de0`), compiling the develop `b6b828772` tree
(`compile src/main.yo --skip-c-compiler --emit-c --profile`). **glibc
malloc, not mimalloc**: it was built in a worktree without `vendor/mimalloc`,
where `--allocator mimalloc` falls back silently
(`issues/questions/explicit-allocator-mimalloc-falls-back-to-malloc-when-vendor-is-missing.md`):

| end of phase | RSS | shared-table entries |
| --- | --- | --- |
| prelude evaluation | 77 MB | 28,624 |
| entry module evaluation | 2,970 MB | 2,872,263 |
| codegen: collect | 3,157 MB | 2,937,610 |
| codegen: emit | 3,324 MB | 2,937,610 |
| write C | 3,328 MB | 2,937,610 |

- Max RSS: **3,526 MB**. That is higher than §0's 3.25 GB because both the
  tree and the compiler are newer; this is the baseline from here on.
- The peak falls between phase boundaries, about 200 MB above the end of
  emit. Something transient, around the final C text assembly, is the
  real peak, and step 2's census has to catch it there.
- Codegen adds 65 K table entries. The 2.87 M entries at the end of
  evaluation are the population lever 1 works on.

### 0.2 Lever 1's upper bound, measured (Phase 0 step 3, 2026-09-29)

Three runs of the same stage-2 (`dda139de0` + the probe) on the same tree:

| run | what | RSS end of collect / emit | max RSS |
| --- | --- | --- | --- |
| A | `YO_CODEGEN_READS=1`: log every key codegen reads | — | 3,561 MB |
| B | `YO_CODEGEN_KEEP=<A's keys>`: drop every entry A never read, before collect | 3,269 / 3,386 MB | 3,829 MB |
| C | plain | 3,157 / 3,320 MB | 3,525 MB |

- Codegen looked up 3,088,597 distinct keys, more than the table's
  2,937,610 entries, because the lookups include misses.
- B dropped **977,569 entries (33 %)**, leaving 1,960,041, and its C is
  **byte-identical** to A's and C's, so the drop is safe.
- It barely saves anything. B's collect-end RSS carries about 110 MB of
  probe overhead (3 M key strings and a set). Net of that, B grew 117 MB
  during emit against C's 163 MB: about 46 MB saved, at most.

The unread entries' `ExprInfo`s are mostly still reachable from something
else: the env snapshots they share, and specialization caches. So lever 1 as
stated (drop unread entries) is small. The 1.7 GB is held by what the
entries point at, which is step 2's (the phase-time census) question to
answer before any lever is ranked.

### 0.3 What holds the 1.7 GB (Phase 0 step 2, 2026-09-29)

A phase-time holder census (`HOLDER_AT_PHASE`, `HOLDER_DEEP` +
`HOLDER_SCAN`) of `compile src/main.yo`, stage-2 C of `dda139de0` built
`-O1` with glibc. The objects reachable from globals total **1,934 MB at the
end of evaluation and 1,910 MB at the end of emit**.

So codegen's own +0.36 GB of RSS is not in any global's graph. It is
codegen's local working set:
- the emitter buffers, holding ~125 MB of C text;
- per-function state.

The census cannot see it, and step 4 below needs a separate accounting of
it.

What `compile` keeps that `check` lets die with each module's walk. First-reach
attribution gives nearly all of it to `g_type_intern`, so read it by type:

| type | objects | MB |
| --- | --- | --- |
| `ExprInfo` (+ `ExprInfoRare` 52 MB) | 2.22 M | 340 |
| `ArrayList(Frame)` | 1.44 M | 206 |
| `AstExpr` | 2.98 M | 183 |
| strings (`ArrayList(u8)`) | 1.82 M | 181 |
| `ArrayList(Variable)` | 243 K | 157 |
| `ArrayList(Self)` (AST argument lists) | 1.92 M | 134 |
| `Environment` | 1.44 M | 133 |
| `Variable` | 786 K | 109 |
| `Token` | 1.71 M | 104 |
| `EvalValue` | 994 K | 77 |
| `HashMap(String, WhereClauseConstraints)` | 219 K | 70 |

- **Environments.** In `compile` the snapshot ring has 3,011,183 hits and
  461,751 misses (`YO_SPEC_REPORT`), so only ~0.46 M of the 1.44 M live
  environments are ring snapshots. A `HOLDER_DEEP_PATH=Environment` census
  names the rest; `expr_info_adopt_env` takes a private `snapshot_env` per
  call.
- **The per-frame map.** Every `Frame` carries an EMPTY
  `where_clause_constraints` map, and `HashMap.new()` allocated 16 buckets
  eagerly.
- **The AST.** It includes 1,531,087 specialization-clone nodes in
  `compile`, the evaluator plan's parked Phase 4 Design 1.

### 0.4 Landed lever: lazy `HashMap` allocation (2026-09-29)

`HashMap.new()` (and `HashSet`, which wraps it) now allocates no bucket
arrays: capacity is 0 until the first insert, which grows it to
`DEFAULT_CAPACITY`.
- `_find_bucket` and `_probe` answer "absent/vacant" at capacity 0.
- `_resize` skips the old-bucket walk when there are no buckets.
- `clear` returns early.

The map OBJECT still exists and is shared by frame copies as before, so
sharing semantics are unchanged. Tests: `tests/collections/hash_map.test.yo`
"HashMap.new allocates nothing until the first insert" (fails on the eager
map) and a Dispose-counter guard for growth from capacity 0.

Stage-2 A/B, same tree, same input (develop `b6b828772`). **Both binaries are
glibc malloc** (built without `vendor/mimalloc`, see §0.1), so the A/B is
like-for-like but not the mimalloc verdict:

| | base | lazy |
| --- | --- | --- |
| `check src/main.yo` max RSS, two runs | 1,081.4 / 1,081.6 MB | 1,061.8 / 1,061.8 MB (−19.6, −1.8 %) |
| `compile … --skip-c-compiler` max RSS | 3,524 MB | 3,441 MB (−83, −2.3 %) |
| end of evaluation (`--profile`) | 2,969 MB | 2,890 MB |
| instructions, `check src/types/intern.yo` | 201,392,029,506 | 201,215,315,433 (−0.09 %) |
| emitted C | | byte-identical |

### 0.5 Landed lever: copy-on-write frame lists (2026-09-30)

`snapshot_env` copied the live env's frame list into every recorded
`ExprInfo.env` (461,751 ring misses plus 1,683,870 `expr_info_adopt_env`
copies in `compile`), and 67 adoption sites copied a recorded list back into
the live env (`env.frames = copy_frames(info.env.frames)`). Now every
environment SHARES the list:
- `snapshot_env` shares `env.frames`;
- the adoption sites assign `info.env.frames` directly;
- the six in-place `push`/`pop` sites (`push_frame`, `pop_frame`,
  `push_env_frame`, `pop_env_frame`, the `comptime_expect_error` frame
  re-push) first call `env_frames_for_write`, which copies while
  `rc(env.frames) > 1`;
- `copy_frames` (now only the copy step of that guard) allocates one spare
  slot, so the push that forced the copy fits without a doubling.

No other code mutates a frame list in place (every other `frames` write
assigns a fresh list), and `Frame` objects were already shared, so a recorded
scope keeps exactly its frame set. Test: `tests/internal/env.test.yo`
"snapshot_env shares the frame list until the source pushes or pops", which
fails on the copying code.

Stage-2 A/B on develop `26e71f6c6` + this branch, **mimalloc, every binary
checked with `nm … | grep ' mi_malloc$'`**, same input tree:

| binary | `check src/main.yo` | `compile … --skip-c-compiler` | end of evaluation | instructions (`check src/types/intern.yo`) |
| --- | --- | --- | --- | --- |
| base (lazy `HashMap`, no CoW) | 971.0 / 971.0 MB | 3,200 MB | 2,648 MB | 86,960,432,373 |
| step 1: `snapshot_env` shares + guards | 929.7 / 929.8 | 3,001 | 2,462 | 86,681,523,225 |
| steps 1+2: adoption sites share too | 935.0 / 934.6 | 2,994 | 2,451 | 86,545,639,351 |
| step 1 + spare slot | 931.9 / 931.9 | 3,006 | 2,463 | 86,631,136,609 |
| **steps 1+2 + spare slot (landed)** | **933.1 / 931.7** | **2,992 (−208, −6.5 %)** | **2,449 (−199)** | **86,448,620,151 (−0.59 %)** |

The emitted C is byte-identical for every row. The landed variant is best on
`compile` (this plan's target) and on instructions; `check` is 2 MB above
step 1 alone and 39 MB below the base.

Where the saving comes from: fewer live lists. A ring miss always follows a
push or a pop, so the COUNT of copies barely changes. What changes is that a
snapshot taken between two mutations no longer carries its own copy, and an
adopted list is not duplicated.

The lazy `HashMap` (§0.4), re-measured on mimalloc against a base without it:
`compile` 3,284 → 3,200 MB (−84), `check` 971.5 → 971.0 (−0.5; mimalloc's
small bins absorbed most of the glibc win), instructions −0.32 %.

**Earlier rows are not comparable with these.** Before this A/B the branch
carried #993's pattern walk (fixed by #996), and its binaries were glibc
(§0.1). The pre-rebase CoW step-1 A/B, glibc against glibc on that tree,
read `compile` 3,469 → 3,237 MB and `check` 1,080 → 1,009 MB. The rows
above replace it.

## 1. Rules carried over from the evaluator campaign

- **Never trade speed for memory.** Speed is measured as instruction counts
  (callgrind on a small input); wall time on the shared Linux box swings
  ±30 %.
- **Stage-2 only**, and the same input tree for A and B (evaluator plan §8.2).
- **mimalloc is the verdict** for the Linux release. A layout change is also
  checked under glibc (the CI ratchets) and reasoned about for 16 B-quantum
  allocators (evaluator plan §0.24).
- **Emitted C byte-identical** is the gate for every retention change
  (self-emit `cmp` plus the corpus). A change that legitimately alters C
  states why and passes `fixpoint_only.sh`.
- **Every bug found gets an `issues/` doc and a test that fails first.**

## 2. Phase 0 — instruments (no behaviour change)

1. **Phase boundaries with memory.** `--profile` phase lines report the RSS
   and the shared table's entry count at the end of each phase (the
   `_current_rss_mb` helper already used by `--watch`). This makes the
   baseline above one command instead of an external sampler.
2. **A census at a chosen phase.** `holder_census_t.py` dumps only at
   teardown, which for `compile` is after the shared table is gone. Add a
   `HOLDER_AT_PHASE=<name>` trigger: the script patches the emitted C so the
   dump runs when that `--profile` phase ends. It needs no compiler change,
   and `HOLDER_DEEP` + `HOLDER_SCAN` then attribute the peak by root and
   type.
3. **Read/unread probe of the shared table.** The 8 GB plan's method: count
   `expr_info_table_get` hits per key during collect + emit, and report the
   entries and bytes never read, split by who minted them. Mint sites
   include:
   - def-time trials of generic bodies;
   - specialization clones;
   - overload-trial clones;
   - module-level evaluation;
   - comptime-only code.
4. **The `Pattern` question.** Decide whether the 38 K unreached `Pattern`s
   are a real leak: rc-balance on `Pattern` (evaluator handover §4.2), or a
   Dispose-counter test around a compiled `match`. If it is a leak, it gets
   an `issues/` doc and a failing test before the fix.

Acceptance: a table in §0 of this document attributing the 1.7 GB and the
0.6 GB to named roots and mint sites, with the date.

## 3. Candidate levers (to rank only after Phase 0)

Listed by the order the evidence suggests; none is committed to before
Phase 0 measures it.

1. **Drop what codegen never reads, as soon as it is known to be unread.**
   After collect, the set of emitted functions is known. Entries that belong
   to bodies nobody emits can go:
   - generic originals' def-time trial infos (the evaluator plan's Phase 4
     Design 2, which only pays in `compile`);
   - overload-trial clones (176 MB in 2026-09);
   - comptime-only functions.

   Mechanism: a keep-set built by the collect walk, then one purge pass
   before emit. Risk: a codegen read of a purged key. Gate: a detector build
   that panics on such a read, plus byte-identical C.
2. **Release per-function evaluator facts after the function is emitted.**
   `g_method_callee_values/_types`, `g_macro_expansions` and `g_match_arms`
   entries of a function whose C is written are dead. That applies only if
   no later function reads them (the probe's per-key last-read time tells).
3. **Codegen's own working set.**
   - `g_emission_occurrence` (478 K entries);
   - per-function emission state;
   - the emitter buffers and the ~123 MB C text.

   The 8 GB plan measured the text as written once. Under `--emit-chunks`,
   finished units could be streamed to disk.
4. **Stop retaining trial-born specializations in the specialization
   cache** (the 8 GB plan's residual).
5. **Phase 4 Design 1 of the evaluator plan** also shrinks `compile`: the
   1.43 M cloned nodes are all retained there. It is parked on
   `mem/phase4-spec-keys`, and this campaign can resume it when Phase 0 says
   it is the largest lever.

## 4. Gates (every change)

1. `yo check ./src` and `yo check ./std`.
2. `yo compile src/main.yo --skip-c-compiler`.
3. Emitted C byte-identical: self-emit `cmp`, and the corpus through
   `scripts/bootstrap/gates_fast.sh`.
4. `scripts/bootstrap/fixpoint_only.sh`.
5. The fast suite, scored by diff against a develop baseline on the same box.
6. Memory recorded here with the date:
   - stage-2 `compile src/main.yo --skip-c-compiler` max RSS (mimalloc);
   - the `--profile` phase RSS;
   - the CI ratchets (`compile_src_main_peak_kb`, re-baselined in the same
     PR when a lever lands).

## 5. Target

Proposed, to confirm after Phase 0:
- stage-2 `compile src/main.yo --skip-c-compiler` below **2.0 GB** max RSS on
  mimalloc (from 3.25 GB);
- the CI cgroup peak (C compiler included) below **2.5 GB** (from 3.36 GiB).
