# T1 GATE 2 fails every golden-mode run, however clean

**Status: FIXED in-tree, awaiting CI confirmation.** Found 2026-08-15 while
diagnosing a red `Self-hosted \`test\` subcommand (yo-self tier-1 gates)`.

## Symptom

The gate reports a failure while every gate in it passed:

```
=== T1 GATE 2: corpus diff-test ===
PASS 155  GOLDEN-DIFF 0  NO-GOLDEN 0  (total 155)
FAIL: corpus diff-test reported a SELF-FAIL: PASS 155  GOLDEN-DIFF 0  NO-GOLDEN 0  (total 155)
  note: out/cjs/yo-cli.cjs missing — no TS arm, falling back to golden mode
...
=== T1_DONE (ci) failures=1 ===
```

GATE 2b `RC=0`, GATE 3 `154/154`, GATE 4 `248/248`, GATES 5-7b all `RC=0`. The
message names a SELF-FAIL that the scorecard does not contain.

## Root cause

`scripts/diff-test.sh` prints **two different scorecards**:

| mode         | when                        | format                                                      |
| ------------ | --------------------------- | ----------------------------------------------------------- |
| differential | TS arm present              | `PASS n DIFF n SELF-FAIL n TS-FAIL n BOTH-FAIL n (total n)` |
| golden       | `out/cjs/yo-cli.cjs` absent | `PASS n GOLDEN-DIFF n NO-GOLDEN n (total n)`                |

`gates_fast.sh:99` asserted `grep -qE 'SELF-FAIL 0( |$)'` unconditionally. That
token **cannot appear in golden mode**, so the assertion failed on every
golden-mode run no matter how clean the result.

The companion `DIFF 0` check passed only by ACCIDENT: `GOLDEN-DIFF 0` happens to
contain the substring `DIFF 0`.

## Why it surfaced now

Golden mode was added in `3a05e98db` (P2.5 Group C), but the gate's assertion
was not taught about it. It only becomes reachable once the TS arm is gone —
which is the **steady state** for this job after P2.5 removed bun/node from it.
So this is a P2.5 consequence, not a compiler regression: run 31856743929
failed the same way well before the 2026-08-15 compiler changes.

## Fix

`gates_fast.sh` GATE 2 now:

1. captures and asserts diff-test.sh's **exit code**, which is mode-agnostic
   (it counts `GOLDEN-DIFF` and `NO-GOLDEN` as failures too) — this leads,
   because the old gate ignored the rc entirely and relied purely on greps;
2. branches on the scorecard actually emitted, checking `GOLDEN-DIFF 0` +
   `NO-GOLDEN 0` in golden mode and `DIFF 0` + `SELF-FAIL 0` in differential
   mode;
3. matches ` DIFF 0` with a leading space so it can never again pass by
   matching `GOLDEN-DIFF`.

## Verify

Drive the assertion with both scorecard shapes and confirm it stays RED for
genuine failures — a gate fix proven only to go green is how gates get
silently disabled:

| scorecard                                        | rc  | expect |
| ------------------------------------------------ | --- | ------ |
| `PASS 155 GOLDEN-DIFF 0 NO-GOLDEN 0 (total 155)` | 0   | pass   |
| `PASS 154 GOLDEN-DIFF 1 NO-GOLDEN 0 (total 155)` | 1   | FAIL   |
| `PASS 154 GOLDEN-DIFF 0 NO-GOLDEN 1 (total 155)` | 1   | FAIL   |
| `PASS 155 DIFF 0 SELF-FAIL 0 ... (total 155)`    | 0   | pass   |
| `PASS 154 DIFF 0 SELF-FAIL 1 ... (total 155)`    | 1   | FAIL   |

All five confirmed 2026-08-15.
