# The vendored mimalloc is compiled in debug mode

**Severity:** S3 — every Linux binary that links `vendor/mimalloc/src/static.c` (the CI stage-2 compiler, the Linux release bundles, `yo compile --allocator mimalloc`) runs mimalloc's internal assertions and fine-grained statistics on every allocation

Found 2026-10-14 while building the evaluator work ratchet (`plans/VALUES_BY_DEFAULT.md` §6, step 3; PR #1359). Not fixed there: fixing it moves the RSS ratchet's baseline and every release bundle, which is its own measured PR.

## Symptom

mimalloc picks its build mode from the preprocessor (`vendor/mimalloc/include/mimalloc/types.h`):

```c
#if !defined(MI_DEBUG)
#if defined(MI_BUILD_RELEASE) || defined(NDEBUG)
#define MI_DEBUG 0
#else
#define MI_DEBUG 2   // + internal assertion checks
#endif
#endif
...
#if (MI_DEBUG>0)
#define MI_STAT 2    // more fine-grained (expensive) tracking
```

No compile line that links `static.c` defines `NDEBUG` or `MI_BUILD_RELEASE`:

- `.github/workflows/test.yml`, "Stage 2: compile the emitted C with clang": `clang … -O2 /tmp/yo-stage2.c vendor/mimalloc/src/static.c -Ivendor/mimalloc/include …`
- `.github/workflows/release.yml` (the Linux and musl bundle compiles) and `.github/actions/build-stage1/action.yml`
- `yo compile --allocator mimalloc` (`src/main.yo`, "Bundled mimalloc allocator": adds `static.c` and the include path, nothing else)

So each of them gets `MI_DEBUG=2` and `MI_STAT=2`.

## Evidence

`MIMALLOC_SHOW_STATS=1 /tmp/stage2/yo-stage2-bin check src/main.yo --std-path ./std` on CI (PR #1359's probe battery, run 38531189992, job "Evaluator memory ratchet") prints mimalloc's per-bin table at exit. A release build (`MI_STAT=0`) keeps only the essential counters and has no per-bin rows:

```
  bin M   41:    25.8 MiB     1.1 GiB    21.6 MiB    20.0 KiB    62.4 K    not all freed
  ...
  binned    :   926.4 MiB   174.8 GiB   393.1 MiB                          not all freed
  huge      :    57.7 MiB   417.3 MiB    38.5 MiB                          not all freed
  total     :   926.4 MiB   175.2 GiB   431.6 MiB
  malloc req:               154.3 GiB
```

The same command's wall time: 403 s (mimalloc, this build) against 358–371 s for the same C recompiled on glibc's `malloc` in the same job. One runner, one sample each, so it is a hint, not a measurement.

## Consequence

- Every allocation and free pays mimalloc's debug assertions and statistics counters. The 2026-08-05 measurement in `test.yml` ("mimalloc costs +53% wall and +15% peak footprint on this workload") was most likely taken on this debug build too, since every line that links `static.c` lacks the define.
- The RSS baseline in `scripts/bootstrap/memory-ratchet.tsv` was recorded on it too, so fixing this moves that baseline (most likely down).

## Fix (as first proposed)

Compile `static.c` with `-DMI_BUILD_RELEASE` (or `-DNDEBUG`, which also disables the C `assert`s of the rest of the unit) on every line above, re-measure `check ./src` wall time and RSS with both allocators, and lower the ratchet baselines in the same PR. The regression check is a CI step that asserts the stage-2 binary does not carry the debug build (for example `MIMALLOC_SHOW_STATS=1` output without the fine-grained table, or `nm` showing no `_mi_assert_fail`).

## Resolution (2026-10-16, `perf/mimalloc-release-build`)

**Measured.** The same emitted C (develop `6986090a1`'s self-compile) was linked twice, then timed on `check ./src --std-path ./std`. The runs were interleaved A B A B under the exclusive heavy lock, on an otherwise idle Ryzen AI Max+ 395 (WSL2):

| Build | Run 1 | Run 2 | Max RSS |
| --- | ---: | ---: | ---: |
| A: as shipped (`MI_DEBUG=2`, `MI_STAT=2`) | 594 s (outlier: the box was not yet quiet) | 292 s | 1,057 MB |
| B: `-DMI_BUILD_RELEASE -DNDEBUG` | 202.1 s | 202.5 s | 1,060 MB |

The same machine's idle run of the as-shipped build that morning took 261 s and 284 s. So the debug build costs about 30–45% of the wall time, and the memory is the same.

**Fixed.**
- Every compile line that links `vendor/mimalloc/src/static.c` passes `-DMI_BUILD_RELEASE`:
  - `yo compile --allocator mimalloc` (`src/main.yo`);
  - `test.yml`, `release.yml`, `fixpoint-arm64.yml` and the build-stage1 action;
  - the C-codegen instructions' example line.
- Why not `NDEBUG`: it would also reach the program's own C and any linked C that uses `assert()`.
- The A/B's release build B also defined `NDEBUG`. For mimalloc the two configurations are identical (`MI_DEBUG` 0, `MI_STAT` 0, no `MI_GUARDED`).

**Regression check.** `test.yml`'s stage-2 step fails when the stage-2 binary contains `mimalloc: assertion`, the message only the debug build carries. A/B check: present in A, absent in B.

**Not changed.** The RSS ratchet baseline, because max RSS did not move locally (1,057 → 1,060 MB, inside its ±10%). If CI's stage-2 number moves, re-record it there.

**What it did not catch.** mimalloc's debug mode detected double frees and corrupted free lists at run time. The sanitizer jobs (ASan, TSan, UBSan on `--allocator system`) remain the memory-error net.
