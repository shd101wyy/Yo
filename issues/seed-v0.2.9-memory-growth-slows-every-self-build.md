# The v0.2.9 seed no longer fits 16 GB, and every seed-driven job pays for it

**Status: ANSWERED, closes with the next `SEED_VERSION` bump.** Found
2026-08-19 while landing #137 (which bumps `SEED_VERSION` v0.2.4 → v0.2.9 in
`test.yml` and v0.2.7 → v0.2.9 in `release.yml`). Timeouts were raised to match
the measured cost; the cause is now measured too — v0.2.9 was cut eight hours
before the memo that halves the footprint, so bumping the pin past it removes
the problem. See "ANSWERED" below.

## Measurement

Same commit, same runner class (`ubuntu-latest`, 16 GB), same step — only the
seed differs:

| job | v0.2.4 seed (develop) | v0.2.9 seed (#137) |
| --- | --- | --- |
| ThreadSanitizer | 16 min | **>60 min — killed by `timeout-minutes: 60`** |
| Bootstrap fixpoint (yo-self self-compile) | 39 min | 53 min |
| Compiler internal tests, shard 0 | 55 min | 56 min |

The pattern explains itself: the jobs that ALREADY provisioned the 32 GB
swapfile moved modestly (+36 %, +2 %), because they were already swapping. TSan
had no swapfile and fitted in RAM at 16 min; the bump pushed it over the 16 GB
line, so #137 gave it a swapfile — correct, and it survives, but swap-thrashing
made the same build roughly **4x slower**, landing exactly on 60:00.

Note GitHub reports a job killed by `timeout-minutes` as **cancelled**, not
failed. It is easy to misread as a spurious cancellation and re-run forever.

## Why it matters beyond one timeout

`release.yml`'s heavy jobs were all `timeout-minutes: 90`, sized for the v0.2.7
seed. `seed-bundles` runs **three** seed-driven self-builds in one job — the
candidate build, the stage-2 re-emit gate, and the portable-c arm — at ~53 min
each. With v0.2.9 that cannot fit in 90 minutes.

**A release that times out burns a version number** (see
`yo-release-candidate-must-emit-bundles.md`: v0.2.8 was burned this way), and
`release.yml` gets no PR CI at all, so this would have surfaced only mid-release.

## What was done

Timeouts raised to the measured reality, in #137:

- `test.yml`: ThreadSanitizer 60 → 120, static-musl 60 → 120 (also seed-driven).
- `release.yml`: the four heavy jobs 90 → 180.

## ANSWERED 2026-08-19 — v0.2.9 predates the memo by 8 hours

Measured directly, same tree, same 16 GB machine (the runners' size), only the
compiler differing. `--emit-c --skip-c-compiler`, so this is evaluation +
codegen without clang:

| binary | its own allocator | wall | peak footprint |
| --- | --- | --- | --- |
| v0.2.4 bundle | mimalloc | 447 s | 14.49 GB |
| v0.2.9 bundle | mimalloc | 475 s | **28.36 GB** |
| current tree | mimalloc | 373 s | 12.67 GB |
| current tree | system | 186 s | 11.42 GB |

Two independent effects, separable because the first two rows hold the
allocator constant:

1. **Code, not allocator.** v0.2.4 -> v0.2.9 doubles peak footprint with both
   built mimalloc, so the growth is real. And v0.2.9 -> current, still at
   mimalloc, drops it 28.36 -> 12.67 GB — a 2.2x reduction.
2. **The cause is timing, not a regression.** `#145` (memoize
   `_inject_forall_captures`, live 19.07 -> 14.94 GB) was committed
   2026-08-18 00:30 UTC. v0.2.9 was cut 2026-08-17 15:56 UTC. **The seed
   predates the biggest memory win by about eight hours.** Nothing regressed;
   we pinned CI to the last build before the fix.

So this is self-correcting: bumping `SEED_VERSION` to the next release removes
it. The raised timeouts (#137) then become headroom rather than necessity, and
should NOT be lowered again on that basis alone — the cliff is what they guard.

### Also measured: mimalloc costs 2x wall-clock on macOS

Rows 3 and 4 hold the CODE constant and vary only the allocator: 373 s
(mimalloc) vs 186 s (system), for ~11% less memory. That independently
justifies #152's macOS flip by a wider margin than the 369.8 s vs 418-429 s it
was argued with. It does NOT transfer to Linux, where glibc inflates the emit's
RSS ~72% and mimalloc remains correct — which is why CI's fix is the seed, not
the allocator.

## Remaining

Why v0.2.9 needs materially more memory than v0.2.4 to compile the same tree.
This is worth understanding rather than absorbing:

- It runs against the narrative of the memory campaign, which cut tracked live
  bytes 19.07 → 14.94 GB (`yo-rc-header-split-census.md`,
  `yo-self-capture-env-memo-r6-r14.md`). A seed built AFTER those wins should
  need less, not more.
- ~15 GB tracked live on a 16 GB runner is right at the cliff, so a small
  regression flips a job from "fast in RAM" to "4x slower on swap". That makes
  CI wall-clock a cliff function of memory, which is why this is worth chasing
  even though the timeouts now absorb it.
- The right measurement is the allocator-boundary histogram in TRACKED LIVE
  BYTES, not macOS `footprint` (see
  `yo-footprint-metric-hides-compressed-live-bytes.md`), and the comparison to
  run is the binary×input matrix — v0.2.4 seed and v0.2.9 seed against the SAME
  tree — since both the compiler and its input change between releases
  (`yo-self-emit-drift-was-input-growth.md`).

Until that is understood, every `SEED_VERSION` bump should be treated as a
potential CI-wall-clock change and the affected job budgets re-checked.
