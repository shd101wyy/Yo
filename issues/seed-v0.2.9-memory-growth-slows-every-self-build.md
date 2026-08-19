# The v0.2.9 seed no longer fits 16 GB, and every seed-driven job pays for it

**Status: OPEN.** Found 2026-08-19 while landing #137 (which bumps
`SEED_VERSION` v0.2.4 → v0.2.9 in `test.yml` and v0.2.7 → v0.2.9 in
`release.yml`). The timeouts were raised to match the measured cost; the
underlying growth is not fixed and is what this issue tracks.

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

## What is NOT done

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
