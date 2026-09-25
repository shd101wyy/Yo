# Building Yo on an 8 GB machine — plan

**Status: BACKLOG 2026-09-25. Starts after
[`EVALUATOR_MEMORY_REDUCTION.md`](../EVALUATOR_MEMORY_REDUCTION.md) closes.**
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
| Type check + C generation (`--emit-c-to`, stops before cc) | 3.56 GB | **6.83 GB** | 5:22 |
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

### Phase 3: bound the C compiler

With Phase 1 done, clang's 3.15 GB is the other half of the peak. The emitted
C shrinks with Phase 2's work. `--emit-chunks` splits it into N translation
units (`plans/reference/CHUNKED_C_EMISSION.md`), but runs up to `--jobs` clang
processes at once, which can use more memory than one large unit. On a small
machine the runner should cap concurrent chunk jobs by available memory. Measure
the per-chunk peak before choosing a default.

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

## 2. Out of scope

- The evaluator's retained memory: that is `EVALUATOR_MEMORY_REDUCTION.md`.
  This plan starts where it stops.
- `yo lsp` on `src/main.yo`: its footprint is the evaluator's, tracked by
  `issues/lsp-memory-grows-per-open-edit-close-round.md`.
- Running `tests/internal` on 8 GB: those files compile the compiler repeatedly
  and `macro_expansion` alone needs 6.5 GB. That is a test-harness question.
