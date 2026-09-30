# cli-diff-test: a case directory without a `cmd` was skipped silently, so a goldens-only case was never scored

**Found:** 2026-09-30, running `async-*` cli-cases by name for the await-site
fusion census (`plans/backlog/ASYNC_AWAIT_SITE_FUSION.md`, F1). Scoring
`async-unwind-value-must-have-the-block-result-type` by name printed
`cmd: No such file or directory` and a tree diff (`only-in-golden: ./main.yo`).
Every whole-corpus run, local and CI, had reported it as nothing at all.

## Symptom

`tests/cli-cases/async-unwind-value-must-have-the-block-result-type/` held
only goldens (`expected_rc` = 0, empty `expected_stdout` and
`expected_home_tree`, an `expected_tree` naming `./main.yo`), with no `cmd`
and no fixture. It was the only case directory in that state. The corpus stayed
green with it, and nothing it was meant to pin was being checked.

## Root cause

Two things, measured from the git history and the harness source.

1. **The harness.** `scripts/cli-diff-test.sh` collected the whole corpus with
   `[[ -f "$d/cmd" ]] && CASES+=("$d")`: a directory without a `cmd` was
   dropped before scoring, with no message. The README says `cmd` is
   required, but nothing enforced it.
2. **The case.** It was authored in #991's branch: `90d5dacc6` added only
   `fixture/main.yo`, with no `cmd` or `opts`. Then `a4944e876` ("drop the
   codegen type check (the evaluator checks unwind values)") deleted the
   fixture and added goldens. The case never had a `cmd`, so it never ran.
   The evaluator check it was about is pinned by the live case
   `check-unwind-type-mismatch-in-async-body-handler`.

## Fix

- The harness now treats every directory under `tests/cli-cases/` as a case,
  and exits 2 naming any case with no `cmd` file, before running anything.
- The orphan directory is deleted: its subject is covered by the live case
  above, and a golden with no command has nothing to reproduce.

## Verification

- With the orphan present, a whole-corpus run exits 2:
  `error: case async-unwind-value-must-have-the-block-result-type has no cmd
  file (every directory under tests/cli-cases is a case)`.
- With it deleted, collection proceeds to scoring as before.
- No case is lost: every other directory has a `cmd`
  (`for d in tests/cli-cases/*/; do [ -f "$d/cmd" ] || echo "$d"; done`
  prints nothing).
