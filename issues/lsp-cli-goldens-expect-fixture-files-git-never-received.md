# Four `lsp-*` CLI goldens expect fixture files that were never committed

**Severity:** S2 — `gates_fast` GATE 7 (the CLI golden scorecard) fails on every branch for these four cases, the develop baseline included.

**Status: OPEN.** Found 2026-09-30 while gating #1041. The cases came in with #1020 (the 2026-09-29 LSP audit).

## Symptom

```
S1=<develop 0de5877fb stage-2> scripts/cli-diff-test.sh lsp-lifecycle lsp-navigation lsp-semantic-tokens lsp-workspace
  GOLDEN-DIFF lsp-lifecycle  (rc=0; tree home)
  GOLDEN-DIFF lsp-navigation  (rc=0; tree)
  GOLDEN-DIFF lsp-semantic-tokens  (rc=0; tree)
  GOLDEN-DIFF lsp-workspace  (rc=0; stdout tree)
```

The tree diff is the same for all four:

```
project tree:
only-in-golden: ./.gitkeep
```

`lsp-lifecycle` also differs in its HOME tree, and `lsp-workspace` in two
stdout lines (a `workspace/symbol` result and a `publishDiagnostics`
payload).

## Cause

The goldens were recorded with a `fixture/.gitkeep` in each case. Their
`expected_tree` lists `./.gitkeep` with the empty-file hash. But git has no
`fixture/` directory for any of them:

```
$ git ls-tree -r --name-only origin/develop tests/cli-cases/lsp-navigation
tests/cli-cases/lsp-navigation/cmd
tests/cli-cases/lsp-navigation/expected_home_tree
tests/cli-cases/lsp-navigation/expected_rc
tests/cli-cases/lsp-navigation/expected_stdout
tests/cli-cases/lsp-navigation/expected_tree
tests/cli-cases/lsp-navigation/opts
tests/cli-cases/lsp-navigation/stdin
```

The recording checkout had files that `git add` never picked up: an
ignored `.gitkeep`, or a global gitignore. Every other checkout runs these
cases in an empty project directory.

## Fix

Commit `tests/cli-cases/<case>/fixture/.gitkeep` (empty) for the four cases,
then re-record and compare only the remaining differences: `lsp-lifecycle`'s
HOME tree and `lsp-workspace`'s stdout. Those are either recording-machine
state as well, or real divergences to diagnose.
