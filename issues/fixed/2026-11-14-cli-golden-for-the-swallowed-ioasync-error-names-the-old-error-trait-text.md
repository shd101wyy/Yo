# The swallowed-io.async-error cli golden names the old `Error` trait text

**Severity:** S3 (a cli-case golden this branch must re-record: the E0601 still
fires and the program is still correctly rejected; only the printed type text
changes — no wrong binary, no user program affected)

**Filed:** 2026-11-14 by the decision 49 S2 lane (`vbd/d49-s2`), from the g4/g6b
Tier 1 cli-diff runs on the merged tree (develop through f463e3fb0). First
filed as develop's stale golden, corrected the same night: the coordinator's
control run (the case alone with this lane's yo-b7 on a PURE develop worktree
at f463e3fb0) is PASS — the golden matches develop; the diff is this branch's
tree.

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

## Root cause (this branch)

This PR respells `AnyError :: Dyn(Error, Clone)` as
`AnyError :: Box(Dyn(Error, Clone))` (`std/error.yo`, decision 49 S2). With
develop's #1941 `Error.source` respell beside it, the trait printer stops
folding the exception payload type and expands `Error` inline; the same yo-b7
binary prints the folded text on a pure-develop tree and the expanded text on
this branch's tree:

```text
error[E0601]: Cannot unify incompatible types: "String" and "dyn(ToString + (source : fn(self : &Self : (ToString)) -> Option(dyn(ToString +  + Clone))) + Clone)"
```

Two cosmetic observations for a printer-lane follow-up (not blocking, not
filed separately): the expanded text contains an empty trait section
(`+  + Clone`), and folding depends on the alias target's shape rather than
the alias name. Nothing here changes which programs are accepted.

## Fix

The golden is re-recorded from this branch's stage-1 binary (yo-b7), after the
diff was read: the only change is the type text of the E0601 line. Verified:
the case alone is `PASS 1 GOLDEN-DIFF 0` after the re-record.

## Test

`PATH=<stage1-dir>:$PATH YO_SELF_BIN=<stage1>
bash scripts/cli-diff-test.sh compile-io-async-body-swallowed-error`
on this branch's tree — GOLDEN-DIFF before the re-record, PASS after.
