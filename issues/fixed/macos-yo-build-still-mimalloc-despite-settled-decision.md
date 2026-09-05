# macOS `yo build` still shipped a mimalloc compiler despite the settled system-allocator decision

**Status: FIXED 2026-08-22** — `build.yo` now picks the allocator per host
platform (`host_allocator`): Mimalloc on the four Linux triples, System
everywhere else.

## What was wrong

The allocator question was already SETTLED per platform by earlier
measurements and decisions:

- **macOS**: mimalloc measured slower AND fatter than libsystem → the release
  bundles ship `--allocator system` (release.yml `seed-cross-emit` matrix,
  "P2.5-era decision").
- **Windows**: mimalloc dropped entirely on both targets
  (`plans/reference/WINDOWS_ALLOCATOR_DECISION.md`) — partly clang-as-plain-C11
  breakage, partly the macOS measurement.
- **Linux**: mimalloc kept (bundles are musl-only; musl's malloc is far
  slower).

But repo-root `build.yo` hardcoded `allocator : build.Allocator.Mimalloc` for
every host — a P2.5 step-24b alignment with the *Linux* CI legs that was never
revisited when macOS flipped. Consequence: every local dev binary on macOS
(and every local benchmark) paid the mimalloc penalty that the shipped
bundles do not.

## Fresh measurement (2026-08-22, Mac Mini M4, `yo check ./src --std-path ./std`, tree cc2a9d904)

| Binary | Wall | User | Peak footprint |
|---|---|---|---|
| mimalloc v3.3.2 (old `yo build`) | 225.6 s | 208.4 s | 16.04 GB |
| mimalloc + `MIMALLOC_PAGE_RECLAIM_ON_FREE=-1` | 139.1 s | 126.1 s | 16.25 GB |
| system allocator | **97.5 s** | **90.0 s** | **14.38 GB** |

2.3× wall-time and ~10% footprint in libsystem's favor. `sample` profiles
attribute the gap to mimalloc v3's abandoned-page machinery: mid-run,
`mi_page_queue_push` alone was 79% of top-of-stack samples, fed by both the
malloc slow path (`mi_page_queue_find_free_ex`) and the free-side
`mi_free_try_collect_mt → mi_abandoned_page_try_reclaim` path. Disabling just
reclaim-on-free (`=-1`) recovers 38%; the rest of the gap is the remaining v3
slow-path traffic under this workload (~50 M live RC objects, heavy
same-thread alloc/free churn).

Side finding from the same session: `YO_GC_THRESHOLD=0` (cycle collector off)
saves only ~4% wall on `check ./src` — the collector is NOT a significant
cost there; the allocator was.

## Follow-ups (open)

- **Linux is unmeasured for the same pathology.** The Linux CI legs and
  fixpoint jobs run mimalloc-built compilers on glibc/musl runners; mimalloc
  v3's reclaim churn may cost there too (or mimalloc may still beat musl
  easily — musl's allocator is very slow). Worth one A/B on a Linux runner:
  glibc/musl vs mimalloc vs mimalloc+`MIMALLOC_PAGE_RECLAIM_ON_FREE=-1`
  on `check ./src`. If `=-1` wins on Linux, set the option at startup in the
  emitted mimalloc init path rather than via env.
- mimalloc upgrades are already blocked on Windows-clang grounds (v3.5.0
  regressions recorded in release.yml comments); this measurement adds a
  reason to re-evaluate the vendored v3.3.2 generally.
