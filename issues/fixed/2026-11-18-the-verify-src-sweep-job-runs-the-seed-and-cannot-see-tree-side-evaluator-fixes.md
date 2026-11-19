# The verify-src sweep job runs the SEED and cannot see tree-side evaluator fixes

**Severity:** S3 (CI plumbing) with a release-blocking consequence: the "Self-verification sweep
(front end, ratcheted)" job evaluates the tree's front end with the installed SEED binary, so an
evaluator fix that lives only in the tree can never turn the job green — the job stayed red on the
v0.2.79 tip that CONTAINS #2001's fix, blocking the cut until either the job is made self-hosted
or a seed past the fix ships (a catch-22 for every release that fixes an evaluator bug its own
front end triggers).

**Status:** FIXED by #2003 (develop `d8f0d89fa`, 2026-11-19): the sweep job now sweeps with the tree-built suite candidate; battery 44347272330 ran it green. Filed 2026-11-18. Red since #1992 (3d) put the trigger shape
(`Rc(AstExprNode)` without `Eq`) into `src/parser.yo`; #2001 fixed the tree but the job did not
change color.

## Symptom

Battery run 44287686080 (tip `b482d44d8`, which contains #2001):

```text
verify-src-sweep: FAILED — no JSON report for './src/parser.yo' (rc=1)
error: (3) Failed to evaluate type expression: Self
    --> ./src/parser.yo:535:20
yo: error: verify: 1 file(s) failed evaluation
```

Measured on the same tip (2026-11-18, Windows stage-1 built from `b482d44d8`):

```text
$ <tree-built stage-1> verify ./src/parser.yo --std-path ./std   # rc=0, "verify: harness OK"
$ yo verify ./src/parser.yo --std-path ./std                      # rc=1, the battery error above
```

## Root cause

`scripts/verify-src-sweep.sh` runs `"$YO" verify <path>` with `YO="${YO:-yo}"`, and the
`verify-src` job in `.github/workflows/test.yml` never set `YO` or built anything — `yo` on that
runner is the installed seed (v0.2.78). The defect #2001 fixed lives in the EVALUATOR of the
binary doing the verifying: the seed predates 3d and the fix, so it still skips both restore pairs
on the callsite-ensures unwind (the full mechanism is
`issues/fixed/2026-11-18-a-dropped-callsite-ensures-clause-leaks-a-cleared-self-type-into-later-evaluations.md`).
The tree's copy of the fix is data the seed reads, not code the seed runs — the job could not have
gone green on any tip, fixed or not, until `SEED_VERSION` passed a release carrying the fix, which
is exactly the release the red job was blocking.

## Fix

The `verify-src` job now `needs: suite-candidate` and downloads the `suite-candidate` artifact
(the tree-built stage-2 binary the cross-emit chain already builds for every full battery), and
sweeps with `YO=./yo-candidate`. Cost: one artifact download plus the wait on `suite-candidate`
(already on the battery's critical path for the cross-emit legs), not a new build. The ratchet is
unaffected: the baseline carries no row for the front-end modules (0 proved), and a rise only
prints.

A job named "Self-verification sweep" sweeping with the seed also under-measured the campaign's
own ratchet: every evaluator improvement between seed releases was invisible to it.
