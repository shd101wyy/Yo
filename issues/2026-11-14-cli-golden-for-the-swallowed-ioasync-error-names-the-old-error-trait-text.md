# The swallowed-io.async-error cli golden names the old `Error` trait text

**Severity:** S3 (a stale cli-case golden: `scripts/cli-diff-test.sh` reports a
GOLDEN-DIFF on develop's own tree; no wrong binary, no user program affected —
the E0601 still fires, only its printed type text changed)

**Filed:** 2026-11-14 by the decision 49 S2 lane (`vbd/d49-s2`), from the g4/g6b
Tier 1 cli-diff runs on the merged tree (develop through f463e3fb0).

## Symptom

```text
── GOLDEN-DIFF  compile-io-async-body-swallowed-error  (rc=1; stdout)
    stdout diff (golden < / run >):
      1d0
      < error[E0601]: Cannot unify incompatible types: "String" and "dyn(ToString + Error + Clone)"
```

The run still rejects the program (rc=1, the span line `bad.yo:5:17` still
prints); only the error's type text no longer matches the case's
`stdout_keep_match` ERE, so the header line is dropped from the kept output.

## Root cause

The case's `expected_stdout` and `stdout_keep_match` name the exception payload
type as `dyn(ToString + Error + Clone)`. Since #1941 respelled `Error.source`
(`std/error.yo`, `Option(Box(Dyn(SelfTrait, Clone)))`), the type printer
expands the `Error` trait inline instead, and every binary now prints:

```text
error[E0601]: Cannot unify incompatible types: "String" and "dyn(ToString + (source : fn(self : &Self : (ToString)) -> Option(dyn(ToString +  + Clone))) + Clone)"
```

Evidence that the branch under test is not the variable: the `vbd/d49-s2`
binaries at 85984c4e3 (b5, develop through #1930), f712d49d1 (b6) and
c6c434de1 (b7) print the SAME line against the tip's `std/error.yo`, and the
case passed the same binary b5 against the 85984c4e3 tree (g3: cli-diff 441/441).
The text follows the tree's `std/error.yo`, which #1941 changed. Develop's own
battery has been red or superseded on every push since #1933 (2026-11-13), so
the stale golden rode in unre-recorded.

Two smaller observations for whoever fixes this:

- The expanded text contains an empty trait section, `+  + Clone` — the
  `Error` expansion seems to contribute an empty remainder. Cosmetic, but
  worth a look in the printer while the golden is healed.
- Healing is a `fix(develop)` one-liner on `expected_stdout` plus the ERE in
  `opts` (or teaching the printer to keep a named trait folded). It should be
  re-recorded from a develop-built binary, not from a lane branch, so the
  golden does not drift with lane-local diagnostics.

## Test

The failing check is the cli-case itself:
`PATH=<develop-stage1-dir>:$PATH YO_SELF_BIN=<develop-stage1>
bash scripts/cli-diff-test.sh compile-io-async-body-swallowed-error`
against develop f463e3fb0 or later — GOLDEN-DIFF today, PASS after the golden
(and ERE) are updated.
