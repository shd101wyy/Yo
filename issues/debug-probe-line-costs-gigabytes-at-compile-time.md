# A 5-line debug-probe enrichment in synthesizer.yo cost +11.7 GB / +2.9x wall of SEED-compile memory — compile-time, with the probe never firing

**Status: OPEN (the probe is reverted; the underlying compile-cost mechanism
is the open part).** Found 2026-08-24 root-causing what was first
misdiagnosed as "S1 std growth hit a memory wall"
(issues/std-s1-prelude-growth-tripled-self-emit-memory.md — superseded by
this doc's finding).

## The numbers (seed v0.2.16, `yo compile src/main.yo --release
--skip-c-compiler`, peak = `/usr/bin/time -l` peak memory footprint)

2×2 over #242's two src files on the develop tree (full S1 std content):

| impl.yo (cell-chain fix) | synthesizer.yo (probe enrichment) | wall | peak |
|---|---|---|---|
| old | old | 140 s | 17.5 GB |
| NEW | old | 140 s | **17.5 GB** |
| old | NEW | 410 s | 29.1 GB |
| NEW | NEW | 390-402 s | 29.1 GB |

So the #242 cell-chain fix is FREE, and the ENTIRE regression is the
`[bind-T]` probe enrichment in `_bind_some_type`
(src/evaluator/types/synthesizer.yo) — a block gated behind
`YO_DEBUG_BIND`, which is UNSET in every one of these runs. The cost is
paid COMPILING the probe, not running it. Line-level split:

- `slot_str := match(old_var.value.get(usize(0)), .Some(ovv) =>
  value_to_string(ovv), .None => String.from("-"));`
  → **+8.7 GB, +220 s** on its own.
- The remaining enrichment (gate conjunct removal + `slot_id=${…}
  src_id=${…} selfm=${….to_string()}` template refs) → **+3.0 GB, +45 s**.

For scale: the whole S0+S1 std campaign (5 merged PRs, ~1,000 added prelude
lines) costs +0.4 GB total (17.1 → 17.5). One probe line cost 22× the
entire campaign.

## Why this went to CI as a "memory wall"

The 16 GB differential-shard runners swap-thrashed under the 29 GB peak
(stage-1 build 12.8 → 60.5 min), heavy internal files then tripped the
600 s evaluator deadline, and all four required shard checks became
un-passable. The budget patch (#244) papered over it and was REVERTED right after the
probe fix: the probe fix restored fast builds (shard build back to minutes
on the first post-fix run), and #244's `--compile-timeout-ms` flag was
INVALID anyway — `yo test` has no such option (the 600 s deadline is
hardcoded on the runner's CHILD compile, src/main.yo ~2506), so every
shard file failed instantly on 'unknown option'.

Measurement trap that delayed the diagnosis: an early baseline ran in a
worktree WITHOUT `vendor/` submodules initialized (the known fresh-worktree
trap), reading 10.0 GB and manufacturing a phantom "S0 tripled memory"
jump. All apples-to-apples (with-vendor) numbers: pre-#238 17.1 GB,
post-S1 17.5 GB.

## Open question — the actual mechanism

Why does compiling ONE gated statement cost gigabytes? The block sits in
`_bind_some_type`, whose body the seed def-time-evaluates and specializes
during the self-emit. Suspects, unverified: (a) def-eval descent into
`value_to_string(<unknown EvalValue>)` from a NEW binding shape exploding
the trial/specialization graph a generation deeper (the old probe already
called `value_to_string(val)` on a parameter, which was cheap — the
difference may be the Option-unwrap match producing a fresh unknown
lineage); (b) per-interpolation costs in the template string (each extra
`${…}` measurably GBs). Distill a minimal repro (a gated eprintln with a
match-unwrapped unknown fed to a large recursive formatter, in a
module-level fn), attribute with the live census
(scripts/bootstrap/live_census.py), and fix the underlying evaluator
behavior — probes must be O(probe size) to compile.

## Rule of thumb until the mechanism is fixed

Debug probes in HOT evaluator files: keep interpolations few and feed them
PARAMETERS or precomputed strings, not match-unwrapped values routed
through big recursive formatters. Measure the self-emit peak
(`/usr/bin/time -l`, with vendor initialized!) before landing any probe in
src/evaluator/.
