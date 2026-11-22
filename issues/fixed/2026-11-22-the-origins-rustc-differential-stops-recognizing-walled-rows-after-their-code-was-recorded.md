# The origins rustc differential stops recognizing walled rows once the wall carries an error code

**Severity:** S3 — the G-C job ("Origins rustc differential", `scripts/origins-diff-rustc.sh`) went red on develop with two unexplained divergences; no compiler behavior was wrong.

## Symptom

Develop run 44986311106 (head `12009acbf`, the first run after #2037 landed):

```text
  FAIL corpus-drop-order-may-dangle: unexplained divergence (yo REJECT, rustc ACCEPT): add a row to DIVERGENCES.tsv or fix the twin
  FAIL corpus-loop-join-push-after: unexplained divergence (yo REJECT, rustc ACCEPT): add a row to DIVERGENCES.tsv or fix the twin
origins rustc diff: 55 agree, 5 diverge (all listed unless FAIL above), 0 walled (compared on their target verdict), 2 failed
```

Run locally on the same tree: `bash scripts/origins-diff-rustc.sh` (rustc only, recorded Yo verdicts).

## Root cause

In its recorded mode the script decides that a Yo program is "walled" (rejected only by the container/cell wall,
so its recorded verdict says nothing about the rule its twin tests, and the manifest's `expect` column is compared
instead) by reading the `today` column of `tests/origins/corpus.tsv`: the text contains the wall sentence, or it
is exactly `-|carries an origin` (the uncoded form, `<code>|<first words>`). #2037 gave the wall the code E0909 and
re-recorded the 20 rows as `E0909|carries an origin`, which matches neither test. Every such row then compared as
a plain REJECT: rows whose target is REJECT still agreed with rustc, but `loop-join-push-after` and
`drop-order-may-dangle` (target ACCEPT, rustc ACCEPT) became divergences no ledger row explains. The walled count
dropped from 5 to 0.

`scripts/origins-gen.py` has the same dependency: `classify` called a rejection a "wall" only when its code was
`-`, so a coded wall would count as `precision` (an over-freeze finding) instead.

## Fix

The recorded-mode wall test matches the text part of the column whatever its code
(`*"|carries an origin"`), and `classify` matches the wall text whatever the code.

## Test

The job is the test: before, `bash scripts/origins-diff-rustc.sh` ends `55 agree, 5 diverge, 0 walled, 2 failed`
(rc 1); after, `57 agree, 3 diverge, 5 walled, 0 failed` (rc 0).
