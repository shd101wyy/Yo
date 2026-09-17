# Tier-1 `check ./std` gate now requires a Z3 solver — `std/async/stream.yo` carries verify-mode contracts and the job has none

**Status: OPEN.** Found 2026-09-17 on PR #755's full battery (run
`35245990956`, job "Self-hosted `test` subcommand (yo-self tier-1 gates)",
GATE 3), and reproduced locally on a **pristine `origin/develop` checkout** at
`054badf38` — so it is pre-existing at that tip, not caused by #755 (a
docs-only PR). The develop push run for that tip was cancelled by the
concurrency rule before it reached this job, which is why the first full
battery to finish (a PR run) is where it surfaced.

## The failure

`yo check ./std` exits 1 with `175/176 file(s) passed` and the summary
`check: 1 file(s) failed evaluator coverage`. The failing file is
`std/async/stream.yo`, which carries verify-mode contracts; its
`check_single_file` tail call goes through `_run_contract_verification`
(`src/main.yo:679`), which prints to stderr (interleaved into the chatter, so
the failure marker greps miss it):

```
verify: no Z3 solver found — this file's verify-mode contracts need proofs (their runtime asserts are suppressed). Run 'yo verify <file>' once to auto-install the pinned Z3, or point YO_Z3_PATH at one.
```

and returns `false` → the file is counted as failed → rc=1 → GATE 3 red.

Which file failed is invisible in the CI log: the summary line and the
`verify:` hint are the only evidence, and the per-file `— evaluator OK`
chatter all prints, so the failed file is not identifiable from the log
alone. Local repro that names it:

```bash
YO_STD="$PWD/std" yo check ./std 2>&1 | grep -n "verify"
# line 25: "...std/async/stream.yo — evaluator OKverify: no Z3 solver found ..."
```

(the `verify:` line lands mid-line because it is stderr against the chatter's
stdout — a separate diagnosibility nit worth fixing while this is fixed.)

## What to do

One of, in the order the repo's own logic suggests:

1. **Install the pinned Z3 in the tier-1 job** — the FV campaign already
   added a verify step to other CI jobs (`yo verify` auto-install, #697's
   "CI verify-job step"); the tier-1 gate job needs the same, since any std
   file with verify-mode contracts now silently turns `check ./std` into a
   solver-dependent gate.
2. Or run the tier-1 `check ./std` with `YO_Z3_PATH` pointed at the same
   pinned solver the verifier jobs use.
3. Or demote `stream.yo`'s contracts out of verify-mode if they were not
   meant to gate `check`.

Direction 1/2 are CI config; 3 is a std/FV-campaign call.

Related: the same run's GATE 7 showed five stale CLI goldens —
[`five-cli-goldens-are-stale-against-the-current-compiler.md`](five-cli-goldens-are-stale-against-the-current-compiler.md).
