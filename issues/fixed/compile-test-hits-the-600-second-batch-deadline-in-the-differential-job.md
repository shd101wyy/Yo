# compile.test hits the 600-second batch deadline in the differential job

**Severity:** S2 — develop's battery goes red with no failing assertion:
`tests/internal/compile.test.yo`'s only batch is killed by the test runner's
compile deadline, so the release gate (a green run on the exact tip) is
missed.

**Status: FIXED 2026-10-13.** The self-hosted differential job passes
`--compile-timeout-ms 1200000` to `yo test`.

## What happened

Develop run 38360830023 (967cbd441), shard 5:

```
yo: error: Yo compilation exceeded the configured time limit (possible evaluator hang). See issues/fixed/test-runner-no-compile-timeout.md.
yo: error: test: tests/internal/compile.test.yo — 0 of 2 tests in this batch ran: the batch failed to compile (exit != 0).
```

The batch started at 07:59:21 and was killed at 08:09:45, after 624 s. `yo test`
gives each batch's child compile `--compile-timeout-ms 600000` unless told
otherwise (`src/main.yo`, the test runner's child argv). The batch evaluates the
whole compiler. On the previous develop run (38333980990) the same file passed,
taking 16.8 minutes in all, C compile included, so the evaluator phase was
already close to 600 s.

## Fix

The differential job is the only CI job that runs `tests/internal`. It passes a
20-minute batch deadline. A real evaluator hang is still caught, well inside
the job's 150-minute limit. The runner's default stays 600 s for everyone else.

## Test

The battery is the test: compile.test passes in the self-hosted differential
job on the merge commit's develop run.
