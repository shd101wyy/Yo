# Cutting test.yml's wall clock

**ARCHIVED 2026-09-17 — CHANGE 1 LANDED in #707 (2026-09-16), WIDENED: BOTH
long non-required legs are sharded 4-way** (`macos-26-intel` and
`windows-11-arm`, via the new `yo test --shard i/n`), consuming a
cross-emitted C artifact so the shards rebuild nothing. The shard suffix
appears only on sharded legs, so the two REQUIRED status contexts kept their
exact names and ruleset 13548862 needed no change — the §"Caution carried
forward" trap, avoided. **Change 2 did NOT land**: the Linux `test` legs
still build their own stage-1 + stage-2 (test.yml's stage-2 step —
load-bearing per `issues/fixed/build-smoke-hangs-registry-perturbation.md`),
so the post-shard wall clock is bounded by those legs, exactly as
§"Expected result" predicted (~86 min). The §"Also worth doing"
`compiler-internal-tests` rebalance was not part of #707. The frozen
2026-09-15 measurement follows.

**Was: ACTIVE — measured 2026-09-15, not yet implemented.**
**Approved by the user 2026-09-14**, to land in its own PR after v0.2.33.

## The critical path, measured

Run `34932915472` (a full battery, 28 jobs). Times are minutes from run start:

| job | start | end | duration |
| --- | --- | --- | --- |
| `Build the suite candidate (Linux, shared by the cross-emits)` | 1 | 37 | **36** |
| `Cross-emit suite compiler (windows-arm64)` | 37 | 52 | **15** |
| `test (windows-11-arm)` | 52 | 118 | **66** |

**Wall clock 118 min**, and that three-stage serial chain IS the tail. It
reproduces the 117 min measured independently on 2026-09-14, so the shape is
stable, not a one-off.

The longest INDEPENDENT job is `test (ubuntu-latest)` at 85 min (t=1..86), with
`test (ubuntu-24.04-arm)` at 81. So ~32 min of the 118 is pure tail: the chain
running after every independent job has finished.

## What is NOT waste — checked, and it refutes the earlier plan

The note this work started from said the ~39 min of building inside each `test`
leg (Stage 1 with the seed, Stage 2 self-application) was probably redundant
with the separate `bootstrap-fixpoint` job and could be dropped. **That is
wrong.** `test` and `suite-candidate` both carry the same comment and the same
citation (`issues/fixed/build-smoke-hangs-registry-perturbation.md`):

> A codegen fix in THIS tree only reaches a compiler's OWN compiled-in async
> machinery one generation later: stage-1's C text was EMITTED by the seed's
> older codegen.

The 2026-09-01 missing-tail-completion hang was invisible at stage-1 and dead at
stage-2. The suite must therefore run under a stage-2 compiler, and that build
time is load-bearing. Any "just reuse stage 1" variant of this plan is unsound.

## The two changes

### 1. Shard `test (windows-11-arm)` — no ruleset change needed

It is the 66-minute tail. Critically, it is **not** a required status check:
ruleset `13548862` requires `test (macos-latest)`, `test (ubuntu-latest)` and
`test (windows-latest)` — not `test (windows-11-arm)` or `test (macos-26-intel)`.
So its name can change without the ruleset swap test.yml's own comment warns
about (line ~1663, and the `compiler-internal-tests` precedent at line 1633,
where the retired TS shard names had to be removed from the ruleset first).

The leg already CONSUMES a cross-emitted artifact and rebuilds nothing, so
shards are cheap — the same argument that justified sharding
`compiler-internal-tests` 4-way (`issues/fixed/selfhosted-differential-job-needs-sharding.md`).

4 shards: 66 -> ~17. **Critical path 118 -> ~69.**

### 2. Let `test (ubuntu-latest)` consume `suite-candidate`'s stage-2 binary

`suite-candidate` already builds a stage-2 Linux binary and uploads it — same
recipe, same generation, same citation as the `test` legs' own stage 2. The
x86-64 leg can download it instead of repeating both stages, dropping ~39 min
of its 85.

Two limits, both real:
- `test (ubuntu-24.04-arm)` is a different architecture and cannot reuse the
  x86-64 artifact. It stays as-is unless an arm64 candidate is added.
- One Linux leg is the ASan leg; check whether its sanitizer configuration
  applies to the compiler binary or only to the code it compiles before reusing
  a non-ASan binary there.

## Expected result

Change 1 alone: **118 -> ~86** (bounded by `test (ubuntu-latest)` at 85).
Both: **118 -> ~69**, the chain 36+15+17.

## Also worth doing, off the critical path

`compiler-internal-tests` shards are imbalanced — 73 / 68 / 49 / 44 min on the
measured run. Rebalancing the striping saves ~29 min on that arm. It ends at
t=73, inside the 86-minute envelope, so it does not move wall clock today, but
it will once changes 1 and 2 land.

## Caution carried forward

Sharding trades wall clock for compute, and is cheap only for jobs that consume
an artifact rather than rebuild. Renaming a job renames a required status check;
if a future change shards a REQUIRED leg, the ruleset swap must land in the same
change or every PR in the repository blocks.
