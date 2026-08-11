# 2.3 blocker: the v0.2.0 seed binary mis-handles compiling current yo-self

**Status: OPEN** (2026-08-11). Found by PR #98's first seed-driven CI run
and reproduced locally.

- **Linux CI (hollow sweep)**: seed-built stage-1 completes but the produced
  compiler FAILS `tests/comptime.test.yo` + `tests/fn.test.yo` (RED) — both
  pass under a TS-built stage-1 of the same source.
- **macOS local**: the v0.2.0 binary compiling current `yo-self/main.yo`
  errors out with `mimalloc: mi_free: invalid pointer` (stage-1 never
  produced).

## Why this was expected eventually

A release binary IS a stage-2-class binary. The yo-self codegen still
carries known self-built-only debt — most prominently the async match
scrutinee-store family (`_store_temp_var_to_state_machine_if_needed` is a
documented no-op stub; the TS-side fixes from PR #92/#93 were never
ported), plus whatever new code shapes landed since v0.2.0 (TestSuite.
exclude, the #95 yo-self changes) that the seed never compiled before.
Compiling current source is the heaviest RC/async workload there is, so the
debt surfaces as invalid frees / subtle miscompiles.

## Path forward (ordered)

1. **Port the scrutinee-store family to yo-self codegen** (the standing
   "yo-self port pending" item) + rerun the fixpoint AND a seed-style
   self-build-of-self battery locally (a self-built binary building the
   source again — stage-2 building stage-1 — is the new pre-release gate).
2. Ship that as v0.2.2-class release; only then bump SEED_VERSION and land
   PR #98 (2.3). v0.2.1 (same codegen, current fixes) may improve things
   but carries the same stub debt — verify before trusting.
3. PR #98 stays open until a seed exists whose self-built stage-1 passes
   the full sweep. The 2.3 workflow changes themselves are correct.

## Repro

```bash
curl -fsSL https://github.com/shd101wyy/Yo/releases/download/v0.2.0/yo-v0.2.0-macos-arm64.tar.gz | tar -xz
YO_MAIN_STACK_MB=4096 ./yo-v0.2.0-macos-arm64/bin/yo compile yo-self/main.yo --release --allocator mimalloc -o /tmp/yo-seedstage1
# macOS: mi_free invalid-pointer errors; Linux: binary produced but
# tests/comptime.test.yo + tests/fn.test.yo RED under it.
```
