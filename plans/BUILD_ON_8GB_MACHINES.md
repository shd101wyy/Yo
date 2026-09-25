# Building Yo on an 8 GB machine — plan

**Status: ACTIVE 2026-09-25.** Phase 1 landed: cc no longer runs beside the
evaluator heap, so a full compile of `src/main.yo` peaks at 6.35 GB instead of
≈ 9.7 GB (§1 Phase 1). Phase 4 items 1–2 landed as one CI job
(`compile_memory_ratchet.sh`: the build inside an 8 GB no-swap cgroup, its
memory.peak ratcheted). Phase 3 measured chunking below the single unit and
landed a memory cap on the default chunk job count. Open: Phase 2 (the codegen
phase), Phase 4 items 3–4 (they wait for a seed that carries Phases 1–2).
Companion: [`EVALUATOR_MEMORY_REDUCTION.md`](EVALUATOR_MEMORY_REDUCTION.md).
That campaign shrinks what `check` retains. This one covers the rest of a
`yo build` of the compiler: the codegen phase, and the C compiler running while
`yo compile` still holds its heap.

**Goal:** `yo build` of this repository completes on an 8 GB machine without
swapping, with the claim held by a CI ratchet, the way `check src/main.yo` is
held today (`scripts/bootstrap/memory-ratchet.tsv`).

## 0. Where the memory goes today

Measured 2026-09-25 on a Mac Mini M4 with a stage-2 compiler built from develop
at #891 (the memory the v0.2.42 seed will have), on the same tree.
`ReleaseSmall` in `build.yo` maps to `--optimize 2` (`src/build_runner.yo`).

| Phase of `yo build` (the child `yo compile src/main.yo --optimize 2`) | Max RSS | Peak footprint | Wall |
| --- | --- | --- | --- |
| Type check only (`yo check src/main.yo`, Linux CI ratchet, authoritative) | 2.43 GB | — | 3:19 |
| Type check + C generation (the `yo` process; `--emit-c-to` did NOT stop before cc, so the wall includes clang — `issues/fixed/emit-c-to-help-says-it-stops-before-the-c-compiler.md`) | 3.56 GB | **6.83 GB** | 5:22 |
| clang `-O2` on the emitted 145 MB C file, alone | 3.15 GB | — | 1:48 |
| **During the cc step: `yo compile`'s heap + clang** | — | **≈ 6.6 + 3.1 ≈ 9.7 GB** | — |

macOS compresses idle pages, so its RSS understates the demand. Footprint
(dirty + compressed) is the number to budget; on Linux, where nothing is
compressed, RSS lands near it.

Sampled every 5 s through a full compile, `yo compile`'s footprint stayed at
6,575 MB for the whole ~100 s clang ran. Nothing is released before the C
compiler starts (`run_compile` in `src/main.yo` awaits
`_cc_command(...).status(io)` with the evaluator and codegen state still live),
so the two peaks stack.

Two further observations:

- **The seed decides the cost.** `yo build` runs the installed `yo`, so a
  machine building with the v0.2.41 seed pays that binary's leaks. Its
  generation step reached 7.7 GB RSS on 2026-09-25. Every claim here holds only
  for a seed at or after the release that lands it.
- **The no-binary path already fits.** Bootstrapping from the portable `yo.c`
  (`scripts/make-portable-c.sh`) first compiles `yo.c` with cc, which is the
  3.15 GB row. The binary it produces then builds the tree, which is the
  ≈ 9.7 GB row.

## 1. Phases

### Phase 1: stop holding the heap while the C compiler runs

This is the cheap step with the biggest win: from ≈ 9.7 GB to
max(6.6, 3.1) ≈ 6.6 GB with no codegen change.

Options, in order of preference:

1. **`yo build` runs the C compiler itself.** The build runner already spawns
   `yo compile` as a child and stays lean. Have that child write the C (and the
   exact cc command line) and exit, then run cc from the runner. The runner
   already owns caching, so the chunked `.o` cache and the poisoned-cache relink
   retry move with it.
2. **`yo compile` `exec`s into cc** when nothing follows the C compiler on the
   single-translation-unit path. The profile print and the failure message
   would move into a tiny wrapper, or be dropped for the exec path. Replacing
   the process image releases the whole heap at no cost. The chunked path keeps
   spawning, because it compiles N units and then links, so it needs option 1.
3. **Free the evaluator and codegen state before spawning.** Rejected as the
   primary mechanism. It depends on every RC graph being released (the census
   still finds unreachable objects at exit), it costs a full teardown walk, and
   the allocator may not return pages to the OS.

Exit check: the §0 sampler (yo + all descendants, footprint every 5 s) shows the
`yo compile` process gone, or under 100 MB, while cc runs.

**Landed (2026-09-25): option 2, generalized to every mode.** `run_compile`
still assembles every argv exactly as before, but the three places that ran
cc (the single-unit compile + link, the chunked `cc -c` per unit + link with
the poisoned-cache retry, and `--static-library`'s `cc -c` + `ar`) now record
a `CcPlan` instead. `_finish_cc_plan` serializes the plan next to the output
(`<output>.ccplan`), flushes the accumulated warnings and stdio, and `execve`s
this same binary as `yo __cc-plan <file>`, which runs the plan in a fresh
image and removes the file. execve keeps the pid, the open stdio and the
parent's wait, so `yo build`, `yo test` batches and shells see the same exit
code and output. It stays in process where the process must come back: any
compile that `main` did not dispatch as the top-level `compile` (`build
--watch`, `YO_TEST_IN_PROCESS`, the warm selfcheck), Windows (its `_exec`
does not keep a waiting parent), `--profile` (the phase table lives in the
first image), and `YO_CC_IN_PROCESS=1`.

Measured with the process-tree sampler on `yo compile src/main.yo --optimize 2`
(stage 1 of the branch, Mac Mini M4): while clang ran, the `yo` process held
1 MB (the plan runner) and clang peaked at 3,262 MB; the front half peaked at
6,345 MB. **Peak 9.7 GB → 6.35 GB.** A failing C compiler still reports
`compile: C compiler failed (exit N) on <file>` with exit status 1, and no
plan file survives. The chunked path also stopped replaying the growing link
line (objects, `-o`, libraries) as each chunk's compile flags on the
poisoned-cache retry: the flags are snapshot where the chunks start.

### Phase 2: shrink the codegen phase

Type check holds about 2.5 GB and C generation adds about 4 GB on top. That
increment is unmeasured territory; the evaluator campaign's census tools have
only been pointed at `check`.

1. Run the holder census (`scripts/bootstrap/holder_census_t.py`, `HOLDER_DEEP`)
   and the zero-hit leak split at the end of **`compile --emit-c-to`**, not
   `check`. The first question is how much of the ~4 GB is leaked (unreachable)
   and how much is retained.
2. Suspects, all to be confirmed by the census before any work:
   - the shared codegen `ExprInfoTable` (`src/module_manager.yo`);
   - per-function emission buffers and `declared_c_var_names` /
     `declared_scopes`;
   - the 145 MB emitted C `String`, plus any copy made to write it out;
   - specialization clones kept alive after their C is emitted;
   - codegen-only side tables with no release point.
3. Fix leaks first, as the evaluator campaign did: a Dispose-counter test and an
   `issues/fixed` doc for each. Then give retention a release point, such as
   dropping per-function state once its C is written, or streaming finished
   functions to disk instead of accumulating them.

Target: generation footprint under 5 GB, which leaves about 3 GB for the OS and
the user's other programs on an 8 GB machine.

**Measured (2026-09-25).** The ~4 GB is neither leaked nor made by codegen. A
probe build logged every `expr_info_table_get` during codegen and the live
malloc bytes (`malloc_zone_statistics`). The live heap was already 5.7 GB at
codegen start, and codegen itself added 0.65 GB (the 146 MB C text, the
emission state, 64 K new table entries). The difference from `check` is the
shared `ExprInfoTable`: `check` gives each module its own table, which dies
with the module's walk, while `compile` keeps one table for the whole run so
codegen can read any function's metadata.

| At codegen end | Table entries | Live heap |
| --- | --- | --- |
| As built | 2,948,949 | 6,348 MB |
| Entries codegen never read dropped (1,031,502) | 1,917,447 | 4,230 MB |
| Whole table dropped | 0 | 2,693 MB |

Tagging every `clone_expr_fresh_ids` id with its call site split the unread
2.1 GB. Executed CTFE body clones held 1.56 GB (119 K entries at ~13 KB each,
because each keeps the env snapshot of a compile-time execution).
Call-overload trial clones held 176 MB, and everything else under 60 MB.

**Landed: an executed CTFE clone's metadata is dropped when the call
returns** (`purge_executed_clone_metadata`, run at the end of
`evaluate_comptime_fn_call`). The purge keeps any subtree that evaluated to a
function: a method or closure defined in the executed body can outlive the
call, and codegen emits it from that metadata. Verified on `compile
src/main.yo`: 268 K ids purged, zero codegen reads of a purged id (detector
build), emitted C byte-identical. **Front-half peak footprint 6.70 → 5.07
GB**, max RSS 5.66 → 4.41 GB. On Linux the whole build (the 8 GB CI job's
cgroup `memory.peak`, C compiler included) went **6,656,632 → 5,090,248 kB
(6.35 → 4.85 GiB)**, now the `compile_src_main_peak_kb` baseline. Record:
`issues/fixed/ctfe-clone-metadata-outlives-the-call.md`.

Not purged: the overload-trial clones. A trial that type-checks a generic
callee with a cloned closure argument creates and caches a specialization
holding the clone, and codegen reads 2,848 of those entries. That 176 MB
needs the specialization cache to stop retaining trial-born specializations,
which is a separate change.

The rest of the suspect list, checked against the probe: the emitted C is
written once (`Emitter.print` makes one copy, and a doubling `String` dirties
only the pages it writes), and per-function emission state is part of the
0.65 GB codegen increment. Neither is worth a change at this size.

### Phase 3: bound the C compiler

With Phase 1 done, clang's 3.15 GB is the other half of the peak. The emitted
C shrinks with Phase 2's work. `--emit-chunks` splits it into N translation
units (`plans/reference/CHUNKED_C_EMISSION.md`), but runs up to `--jobs` clang
processes at once, which can use more memory than one large unit. On a small
machine the runner should cap concurrent chunk jobs by available memory. Measure
the per-chunk peak before choosing a default.

**Measured (2026-09-25, Phase 1 stage 1, Mac Mini M4, process-tree sampler
every 2 s):** `yo compile src/main.yo --optimize 2 --emit-chunks auto` made 10
units (the largest 21.5 MB of C plus the 3.9 MB shared header) and compiled all
10 at once (`jobs=10`).

| Step | Peak |
| --- | --- |
| Front half (check + C generation), then the image is replaced | 6,894 MB |
| All 10 `clang -c` at once | 2,106 MB total; the largest single clang 345 MB |
| ThinLTO link (`ld`) | 2,300 MB |
| Single unit, for comparison: one `clang -O2` on the 145 MB file | 3,262 MB |

So on this tree chunking uses **less** memory than one unit, even at full
parallelism: clang's peak grows faster than its input (13.6 bytes per byte of
C for a 25 MB unit, 22.5 for the whole file). The concern in the paragraph
above does not bite at today's sizes; the front half, not the C compiler, is
the peak.

**Landed: a memory cap on the default job count.** An explicit `--jobs` is
kept as given. When it is defaulted (8, or the `auto` cap), the plan runner
lowers it to what fits in half of physical memory, with a per-job estimate of
64 MB plus 24 bytes per byte of the largest unit's C. That estimate sits above
both measurements: 664 MB against 345 for the 25 MB unit, 3.5 GB against 3.26
for the whole file. Physical memory comes from `sysctlbyname("hw.memsize")` on
macOS, `GlobalMemoryStatusEx` on Windows, and `MemTotal` on Linux, lowered to
the process's cgroup v2 `memory.max` so a capped CI runner or container counts
as the small machine it is. `YO_ASSUME_MEMORY_MB=<n>` overrides the figure; the
`compile-emit-chunks-memory-cap` CLI case pins it to 100 and records `jobs=1`,
while `--jobs 4` still records `jobs=4`. On an 8 GB machine the cap is 6 jobs
for today's units, about 2 GB of clang at the measured peaks.

### Phase 4: ratchet and CI

1. Add `compile_src_main_max_rss_kb` to `scripts/bootstrap/memory-ratchet.tsv`.
   Measure it with the stage-2 compiler, including descendants, so the cc step
   counts, and fail both ways at ±10% like the `check` row.
2. Add a CI leg that builds the compiler under an 8 GB cgroup limit
   (`systemd-run --scope -p MemoryMax=8G`, no swap). That is the claim itself,
   tested.
3. Once the seed carries Phases 1–2, shrink the 32 GB swapfiles in
   `.github/workflows/test.yml` and `release.yml`. They are sized for seeds
   without these fixes.
4. State the requirement in the install docs, `docs/en-US/` and `docs/zh-CN/`:
   8 GB RAM, with a seed at or after the release that lands this.

**Items 1–2 landed (2026-09-25) as one job**, "Compiler build inside 8 GB"
(`scripts/bootstrap/compile_memory_ratchet.sh`, in `test.yml` after the
bootstrap fixpoint). It compiles `src/main.yo` at `--optimize 2`, C compiler
included, with the stage-2 binary inside a `systemd-run --scope` capped at
`MemoryMax=8G` with `MemorySwapMax=0`, and reads the scope's cgroup
`memory.peak`. That figure covers every process in the tree. GNU time's max
RSS does not: Linux `wait4` reports the largest single process, which would
have measured the old layout as 6.6 GB when the machine needed 9.7. The job
fails on an OOM kill or a non-zero exit whatever the baseline says, and
otherwise compares the peak with `compile_src_main_peak_kb` at ±10% both
ways. First recording, ubuntu-latest: **6,656,632 kB (6.35 GiB), rc 0,
`oom_kill` 0, 680 s.**

## 2. Out of scope

- The evaluator's retained memory: that is `EVALUATOR_MEMORY_REDUCTION.md`.
  This plan starts where it stops.
- `yo lsp` on `src/main.yo`: its footprint is the evaluator's, tracked by
  `issues/lsp-memory-grows-per-open-edit-close-round.md`.
- Running `tests/internal` on 8 GB: those files compile the compiler repeatedly
  and `macro_expansion` alone needs 6.5 GB. That is a test-harness question.
