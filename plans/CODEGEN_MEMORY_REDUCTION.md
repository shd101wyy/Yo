# Codegen memory reduction — audit and implementation plan

**Status: ACTIVE, opened 2026-09-29.** This picks up where
[`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md) paused (§8
there). That campaign cut what `check` retains to 970 MB. This one covers what
`compile` holds on top of it: the evaluator state kept alive for codegen, and
codegen's own working set.

Status as of 2026-09-30:
- **Phase 0's instruments are in** (§0.1–§0.3, §0.6): `--profile` phase
  memory and `profile: mark` lines.
- **Landed levers** (on `mem/codegen-plan`):
  - lazy `HashMap` (§0.4);
  - copy-on-write frame lists (§0.5);
  - emit's C sections with in-place truncation (§0.6);
  - the code spill (§0.10).

  Together `compile` goes 3,284 → **2,766 MB** on mimalloc (−16 %) and
  `check` 971 → 932 MB, with fewer instructions and byte-identical C.
- **Measured and rejected:** env interning (§0.7) and per-function env
  release (§0.8).
- **Next:**
  - §3 lever 6: shared path collections;
  - after #1002 and #1016 land: Phase 4 Design 1 (the specialization clones)
    and env-free codegen (§6).

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

### 0.6 After §0.5: the census re-ranked, the env ceiling, emit's copies (2026-09-30)

**Census at the end of evaluation** (`HOLDER_AT_PHASE`, stage-2 C of the
§0.5 tree, glibc, 1,945 MB reached from globals):

| type | MB | objects | vs §0.3 |
| --- | --- | --- | --- |
| `ExprInfo` | 381 | 2.48 M | the tree grew (#993–#996) |
| strings (`ArrayList(u8)`) | 220 | 2.03 M | 70 MB of it redundant copies (`HOLDER_DUPSTR`; the top groups are 1–2-byte literals such as `"1"` and `"Some"`) |
| `AstExpr` | 203 | 3.32 M | |
| `ArrayList(Variable)` | 183 | 277 K | frames' variable lists, reached through recorded envs (`HOLDER_DEEP_PATH`) |
| `ArrayList(Self)` | 150 | 2.14 M | |
| `Environment` | 148 | 1.58 M | |
| `Variable` | 123 | 888 K | |
| `Token` | 115 | 1.89 M | |
| `ArrayList(Frame)` | 44 | 337 K | **206 MB before §0.5** |
| `HashMap(String, WhereClauseConstraints)` | 15 | 250 K | **70 MB before §0.4** |

**The recorded envs' ceiling, measured.** `YO_DEBUG_DROP_ENVS=1`, a
measurement-only knob on a scratch branch (not in the tree), points every
`ExprInfo.env` in the shared table at one empty env just before "contract
verification". The census's exact glibc chunk walk (every live allocation,
reached or not) then reads:

| | live chunks | live heap |
| --- | --- | --- |
| envs kept | 28.4 M | 2,891 MB |
| envs dropped | 22.7 M | 2,145 MB (**−746 MB, −26 %**) |

That is what only the recorded envs keep alive: the `Environment` objects,
their frame lists, the `Frame`s and variable lists no live scope holds, and
the `Variable`s with their values. It is by far the largest lever left.
(The reached-from-globals totals, 1,959 vs 1,681 MB, undercount the kept
case: its walk left 7.4 M objects unreached against 3.8 M, so only the
chunk walk is comparable.)

Codegen reads recorded envs in about 30 places, for two things:
- the innermost `Variable` of a name, via `get_variables_from_env` and
  `get_variable_name_for_codegen`, for identifiers, deferred dups/drops and
  arm values;
- the env's `module_path`, via `is_temp_variable_name`.

It never mutates one: the only env codegen writes is a fresh `clone_env` in
`functions/collection.yo`. See §3 lever 0.

**Emit's whole-buffer copies.**
- `Emitter.print()` concatenated headers, declarations and code (~125 MB) into
  a fresh doubling `String` at the end of emission.
- `_emit_capture_drop_lines` rebuilt the code buffer with
  `substring(0, before)` once per spawned closure.
- The FTT-stub path copied the code prefix byte by byte, and
  `_insert_attr_before_first_decl` cloned all three buffers to search them.

Now:
- `compile_module` returns `Emitter.sections()`, and `main.yo` writes (and,
  under `--emit-c`, prints) the parts in order;
- `String.truncate` truncates in place, as `clear` already did, and the
  code-buffer sites use it;
- the search shares the buffers.

Measured without `--emit-c` (a 0.5 s RSS trace, mimalloc stage-2s, the same
tree): max RSS 2,921 → 2,912 MiB, C byte-identical. The concatenation had set
the peak (2,921 = end-of-emit 2,797 plus the copy). The peak now is a
different ~114 MiB transient about 7 s before the end of emit, present in
every variant. `--profile` now prints `profile: mark` lines (rss and VmHWM)
between the emit steps to find it.

### 0.7 The emit spike found; env interning rejected (2026-09-30)

**The ~114 MiB transient is one async state machine.** The `profile: mark`
lines, plus a scratch mark that records only when VmHWM grows by ≥ 50 MB,
put it inside `generate_deferred_async_blocks`, at block 84 of 143:
`fetch_package` (`src/fetch.yo`), an `io.async` body with about a dozen
top-level awaits.
- Peak 2,869 → 2,991 MB across that one block; RSS is back to 2,877 MB by
  the end of the loop.
- The code buffer grows only 117 → 122 MB over all 143 blocks, and no emitter
  buffer is copied or doubled there (the marks print the three buffer
  lengths).

So it is that block's lowering working set, super-linear in its
segment/continuation handling. #1002 (async state machines phase 5: a
single-pass lowering that deletes the segment/continuation emitters) and
#1016 rewrite exactly this path, so it is left to them. Re-measure once both
land.

**Env interning (§3 lever 0a): measured and rejected.** One pass before
collect pointed every entry at a canonical frozen env per identity: frame
objects by `index_key`, module path, declaration frame level, input string.
- The self-build's 2,890,218 entries hold **264,188 distinct envs**, 91 %
  duplicates.
- `YO_DEBUG_FROZEN=1`: 0 panics. The C was byte-identical.

| | base | interned |
| --- | --- | --- |
| end of collect | 2,634 MB | 2,614 MB |
| end of emit | 2,803 MB | 2,783 MB |
| max RSS | 2,987 MB | 2,966 MB (−21, −0.7 %) |
| the pass | | **12.1 s** |

The ~1.3 M freed `Environment` objects (~120 MB reachable) return little
RSS: they are freed after evaluation grew the heap, as 96 B slots scattered
over mimalloc pages that only same-size allocations reuse. 12 s for 0.7 % is
a speed-for-memory trade, so it was reverted. The duplicate count stays
useful, though: a scope-level identity would let `expr_info_adopt_env` or the
snapshot ring share at creation time, while evaluation is still allocating
envs. That is not attempted here.

### 0.8 Releasing an emitted function's envs: measured and rejected (2026-09-30)

§3 lever 0b as first written: after each `generate_function`, walk the body
(following macro expansions, stopping at nested function literals and
`io.async` bodies) and point every node's `ExprInfo.env` at one released env.
- **It frees almost nothing:** end of emit 2,801 → 2,795 MB, the mark after
  function bodies 2,797 → 2,786. A body's frames and variables stay
  reachable from the recorded envs of everything not yet emitted: module-level
  entries, never-emitted trial evaluations, and the functions still to come.
  The same scopes are shared across all of them.
- **It is not byte-identical:** a later function's borrow check (an extra
  `__yo_borrow_assert_unborrowed(diagnostics)`) reads an earlier body's
  envs.

Reverted. What the two experiments (§0.7, §0.8) establish is that the 746 MB
of §0.6 is freed only by dropping every recorded env, and codegen reads them
until the end. The lever that remains is structural: resolve at the end of
evaluation what codegen asks of an env, then drop all recorded envs before
codegen. Codegen asks, per `ExprInfo`, for:
- `get_variables_from_env(env, name)` / `get_variable_name_for_codegen` for
  a name;
- the module path;
- two module-level/comptime-only predicates in `exprs/assignment.yo`.

Today those queries are answered lazily, against arbitrary names and scopes.
The design must first make the set of names finite per `ExprInfo`: the
node's own identifier, its deferred dup/drop targets, and its `variable_name`.
It is the next piece of work on this plan, as its own design section.

### 0.9 Gates for §0.4–§0.6 as landed (2026-09-30)

The branch tip's stage-2 (mimalloc, src identical to `ee4022e79`), on the
WSL2 box:
- `check ./src` 279/279; `check ./std --std-path ./std` 176/176.
- The fixpoint holds.
- `gates_fast`: the same 8 failures as the develop-based baseline on the same
  box, six LeakSanitizer verdicts CI switches off (`YO_TEST_LEAK_VERDICT=0`, now `gates_fast.sh`'s default too) and six CLI goldens (`issues/cli-goldens-doc-and-fixed-oom-shapes-fail-outside-ci.md`);
  the corpus is 156/156 golden.
- The fast suite (`tests` minus `internal` and `cli-cases`), each binary in
  its own worktree: branch 4,440 passed / 161 failed, baseline 4,438 / 163.
  The branch's failures are a subset of the baseline's (the two extra
  baseline failures are the timing-sensitive `spawn_blocking` tests).
  - Running two suites in ONE checkout collides on batch file names:
    `issues/concurrent-yo-test-runs-in-one-directory-overwrite-each-others-batches.md`.

### 0.10 Landed lever: the code spill (§3 lever 3, 2026-09-30)

Function bodies no longer accumulate in memory.
- **`Emitter.start_code_spill(path)`:** `compile_module` opens
  `<output>.yo-code-spill` unless in chunk mode, whose units are cut from
  byte ranges into the buffer.
- **`spill_code_if_large()`:** after every emitted function, once `code`
  holds `code_spill_threshold` bytes (8 MiB), it is written to the file
  (`write_sync`) and cleared, keeping its capacity.
- **Why a function boundary:** every in-buffer offset a function takes
  (`before` in `_emit_capture_drop_lines`, FTT stub marks) is still valid
  there.
- **`_insert_attr_before_first_decl`:** also searches the spilled part and
  rewrites it on a hit (`rewrite_code_spill`, rare).
- **`main.yo`:** writes headers, declarations, the spill copied in 4 MiB
  pieces (`_copy_file_into`), then the in-memory tail. `--emit-c` reads the
  spill whole.

Tests: `tests/internal/chunk_assembly.test.yo`, "a code spill spliced before
the code tail is the unspilled C" and "rewrite_code_spill replaces the
spilled code and its length".

Mimalloc stage-2s, same tree, no `--emit-c`, C byte-identical:

| | before | spill |
| --- | --- | --- |
| end of emit | 2,803 MB | 2,696 MB |
| peak across deferred async blocks | 2,917 MB | 2,696 MB |
| max RSS | 2,987 MB | **2,766 MB (−221, −7.4 %)** |

The `fetch_package` transient of §0.7 is gone with it: that block's working
memory had been sized by the ~117 MB code buffer. A first version read the
spill back whole at write time and peaked at 2,999 MB, which is why the copy
is chunked.

**Measured next: `ExprInfo.path_collection`.** The census puts 710 K
`ArrayList(ArrayList(String))` (44 MB) and 775 K `ArrayList(String)`
(47 MB), plus their strings, in the borrow checker's access paths. Only
**185,186 distinct contents** exist among them (`YO_SPEC_REPORT` scratch
count, 2026-09-30), about 3 of every 4 a duplicate. Sharing them needs
`expr_info_paths_for_write` to copy when shared (today it copies only the
empty sentinel), the same shape as §0.5. That is §3 lever 6.

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

0. **Recorded envs (§0.6: a 746 MB ceiling).**
   - (a) Hash-cons content-equal envs once evaluation is done: 1.58 M
     `Environment` objects over 337 K distinct frame lists. Canonical envs are
     frozen, and `YO_DEBUG_FROZEN=1` proves nothing mutates one.
   - (a′) **Rejected (§0.7)**: −21 MB for 12 s.
   - (b′) **Rejected (§0.8)**: −6 MB, and not byte-identical.
   - (b) Release a function's recorded envs once its C is written. Codegen
     emits one function at a time, and a body's envs are dead after its
     emission unless a later step reads them (deferred async blocks, dyn
     wrappers). So, after each emitted function, point its body's
     `ExprInfo.env`s at one poison env, keeping those a deferred step still
     needs. Frames and variables are then freed while emit runs, and their
     slots are reused by emit's own allocations. Gates:
     - byte-identical C;
     - a poison env that panics under a debug knob when read, run on the
       self-compile and on `gates_fast`'s corpus.

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
6. **Share equal path collections (§0.10: 185 K distinct among ~710 K).**
   `expr_info_paths_for_write` copies while the collection is shared, and
   equal collections are interned when they are recorded. Measure the RSS,
   not only the census: §0.7 showed that memory freed after evaluation has
   peaked comes back only partly.

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

## 6. Design (not started): env-free codegen, for §0.6's 746 MB

**Why.** Recorded envs keep 746 MB of the end-of-evaluation heap alive
(§0.6), and only dropping all of them frees it (§0.7, §0.8). Codegen reads
them until the last function is written.

**What codegen asks** (2026-09-30: every `<x>.env` read under `src/codegen`,
about 100 sites in 25 files; `exprs/return.yo`, `async/state_code_gen.yo`,
`exprs/drop_dup.yo`, `exprs/cond.yo` and `exprs/atom.yo` carry most):

| query | sites | what it needs |
| --- | --- | --- |
| `get_variable_name_for_codegen(name, Some(env))` | 42 | the innermost `Variable` named `name` visible in that scope (its C name, extern-ness, module qualification) |
| `is_temp_variable_name(env.module_path, name)` | 28 | only the env's module path |
| `get_variables_from_env(env, name)` | 22 | the visible `Variable`s named `name`, innermost last |
| `_last_is_module_level` / `_last_is_compile_time_only` (`exprs/assignment.yo`) | 5 | two flags of the innermost `Variable` |

**The shape.** Every query is `(env, name)` → the visible `Variable`s of one
name, plus the module path. The names are not arbitrary. At each site the
name is one of:
- the node's own identifier token;
- its `ExprInfo.variable_name`;
- the atom name of one of its deferred dup/drop/consumed expressions;
- a name codegen derived from those.

**Audited 2026-09-30** (a read-only pass over every read path, 114 rows):
the hypothesis holds for about 90 of them. The name is the env owner's own
token, its `variable_name`, or a deferred dup's `variable_name`. The
`is_temp_variable_name` rows (28) need only the module path. The rows that
break it, by kind:
- **Pending drops at a cleanup point.** `exprs/atom.yo:336` (break/continue),
  `exprs/return.yo:315` and `:497` look up the names of the ENCLOSING
  scopes' pending drops (`context.pending_deferred_drops`,
  `consumed_var_pending_drops`) in the cleanup node's env, then match all
  same-named `Variable`s by id (`_resolve_drop_target_in_scope`). Fix: a
  pending drop carries the resolved `Variable` from where it was
  registered. The cleanup point's lookup becomes an identity check.
- **A name from another node, looked up in this node's env.**
  - `exprs/init_assignment.yo:328` and `async/state_machine.yo:223`: the lhs
    of `:=` looked up in the `:=` node's env, deliberately, since the lhs
    atom's env predates the binding.
  - `exprs/property_access.yo:343`: a field token in the `.` node's env.
  - `exprs/assignment.yo:86`: a path-collection base in the lhs env.
  - Capture-struct labels in `exprs/closures.yo:221–223`,
    `exprs/async.yo:1605/1612/3137`.

  These are still a finite name set per node, just not the node's own.
  The record must include them.
- **Whole-env scans.**
  - `exprs/await.yo:133` and `async/state_machine.yo:1287` iterate every
    variable to find `given` bindings.
  - `exprs/other_fn_call.yo:983–1049` asks whether the innermost frame
    holding X lies above `function_declaration_frame_level` and is a begin
    block.

  Fix: evaluation records the answer (the implicit `given` bindings in
  scope, the handler-installation boolean) on those call nodes.
- **Late evaluations.** `functions/collection.yo` evaluates `trace`
  specializations and synthesized `___dispose`/`___drop` during codegen
  (`clone_env(module_env)`, not an ExprInfo env). Their new ExprInfos need
  records too, so records are filled when an ExprInfo is created, not in a
  pass at the end.

`get_variable_name_for_codegen` reads more than the innermost match:
`is_parameter` over all matches, the extern-C type meta, the module-global
registries. So the record stores resolved `Variable` handles, and the C name
is still computed at emission. Precedent: `ExprInfo.source_variable` already
stamps one `Variable` per info.

Most of these rows are in `src/codegen/async/` and `exprs/async.yo`,
`await.yo` and `match.yo`, which #1002/#1016 rewrite. The refactor starts
after they land.

**Proposed.**
1. **Enumerate the names.** Log each site's `(ExprInfo key, name)` under a
   knob (the `YO_CODEGEN_READS` pattern), run the self-compile and
   `gates_fast`'s corpus, and check that every queried name comes from the
   four sources above. Any site that queries another name is redesigned
   first.
2. **Resolve at the end of evaluation.** Per `ExprInfo` that codegen can
   read, resolve those names once. Store the results in a side table keyed
   like the ExprInfo table (`ExprId → [(name, [Variable])]`), and keep the
   module path as a shared `String`.
3. **Switch codegen over.** Answer the four queries from the side table. Then
   point every recorded env at one empty env before collect.
4. **Gates:**
   - byte-identical self-emit;
   - `gates_fast`'s corpus;
   - a knob that panics when an emptied env is queried;
   - `YO_DEBUG_FROZEN=1`.

**Open questions.**
- **Lazy evaluation during collect.** Specializations are forced while
  collect runs, and table entries grow 2.887 M → 2.953 M. Their envs are
  resolved when they are created, or collect keeps envs until it ends.
- **Late readers.** `generate_deferred_async_blocks` and dyn wrappers read
  bodies late. §0.8 found a borrow check that reads another function's body.
- **The side table's own size.** The `Variable`s it keeps are a subset of
  what the envs keep, and the freed remainder must be measured, not assumed.

