# The `fix-migrate-unsized-str` golden recorded the summary line from before #1981 changed it

**Severity:** S3: a stale cli golden. `cli-diff-test.sh` scored `fix-migrate-unsized-str` GOLDEN-DIFF on develop from #1981 on, so the self-hosted `test` subcommand job would have reported it red; the compiler's behaviour was right.

## Observed

```text
── GOLDEN-DIFF  fix-migrate-unsized-str  (rc=0; stdout)
      < fix: rewrote 0 `dyn(...)` site(s) to `dyn(Box.new(...))` and 0 box lend(s) `&b` to `&b.*` and 7 `str` type(s) ...
      > fix: rewrote 0 box lend(s) `&b` to `&b.*` and 7 `str` type(s) to `&(str, static)`; 1 site(s) listed for a hand rewrite; ...
```

## Root cause

#1980 (the `str` flip, R3) recorded this golden while `yo fix --migrate unsized` still counted the plain `dyn(v)` rewrites in its summary. #1981 (S3b-`Dyn`, R4) merged next, deleted that rewrite (a plain `dyn(v)` is E0620 with a structured repair now) and dropped the count from the summary line, but did not re-record the case: the two PRs each passed their own Tier 1 and met only on develop.

## Fix

Found by the R8 PR's cli-diff gate (it runs every `fix-*` case) and re-recorded there, after reading the diff: only the `0 dyn(...) site(s) to dyn(Box.new(...))` clause leaves the two summary lines. The case itself is the regression test: it failed on develop before and passes after.
