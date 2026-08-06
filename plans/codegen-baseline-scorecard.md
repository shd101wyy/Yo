> **CLOSED (2026-08-06).** The bootstrap campaign this document belongs to is
> complete: the self-hosted compiler passes the full suite, the stage-2/stage-3
> fixpoint holds, and every CI job gates PRs (run 31069479984, commit
> `ac85f6cfc`). Kept as a historical record — do not resume work from this
> file. Umbrella status: `plans/BOOTSTRAPPING.md`. What comes next:
> `plans/SELF_HOSTING_COMPLETION.md`.

# Codegen bootstrap — Phase 0 baseline scorecard

Committed baseline for the codegen self-hosting slice
(`plans/BOOTSTRAPPING_CODEGEN.md`). Captured by the differential harness
`scripts/diff-test.sh`; re-run it after every porting batch and watch the
`SELF-FAIL` count shrink toward 0 with no `DIFF`/`TS-FAIL` ever appearing.

## Run

```
scripts/diff-test.sh tests --parallel 4
```

- **Date:** 2026-06-13
- **Host:** Darwin arm64 (macOS), clang 21.1.7
- **TS reference compiler:** `node out/cjs/yo-cli.cjs` @ `da879b9be`
- **Self-hosted binary:** `/tmp/yo-self-bin`, built by the TS compiler from
  `yo-self/main.yo` @ `da879b9be` (`compile`/`test` THROW by design — the
  self-hosted codegen was deleted clean-slate per the plan)

## Scorecard

| Verdict     |   Count | Meaning                                                       |
| ----------- | ------: | ------------------------------------------------------------- |
| `PASS`      |       0 | both compiled+ran, behavior matched                           |
| `DIFF`      |       0 | both ran, behavior differs (port MUST drive to 0)             |
| `SELF-FAIL` |     172 | self-hosted compiler failed; TS succeeded (expected baseline) |
| `TS-FAIL`   |       0 | TS reference failed (would flag a broken test)                |
| `BOTH-FAIL` |       0 | both failed                                                   |
| **total**   | **172** | every `tests/*.test.yo` (non-runnable fixtures excluded)      |

Every file is `SELF-FAIL` because `yo-self-bin test` throws immediately
(rc=1) pending the port. On the TS side the reference is fully green:
**2595/2595** tests pass across the 172 files (`ts=N/N(rc0)` on every row).

## Interpretation

- `0 TS-FAIL` confirms the harness's file selection is correct: it runs
  only the 172 runnable `*.test.yo` units and skips the 12 plain-`.yo`
  fixtures/helpers (no `export(main)`), which are not standalone-compilable.
- `0 DIFF` / `0 BOTH-FAIL` is trivially true at baseline (self never
  produces a binary yet) but is the invariant the whole port preserves.
- **Definition of progress:** each porting batch should convert some
  `SELF-FAIL` rows to `PASS` without ever introducing a `DIFF` or
  `TS-FAIL`. The harness exits non-zero iff a `DIFF`/`TS-FAIL` appears, so
  it doubles as a CI-style regression gate.

Raw per-file output for this run is reproducible with `--parallel 4` (or
`-v` for a live per-file log); it is not checked in to avoid churn on a
deterministic all-`SELF-FAIL` result.
