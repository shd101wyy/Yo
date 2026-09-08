# `yo fmt` walks `.gitignore`d files, so `--check ./tests` fails on test-runner scratch

**Status: OPEN.** Found 2026-09-09.

## Symptom

```
$ yo fmt --check ./tests
The following Yo files need formatting:
tests/string/.yo_selftest_batch_192_0.yo
```

`.yo_selftest_batch_*` is the test runner's own scratch — the file it inlines
every test body of one file into before compiling the batch. It is
`.gitignore`d (`.gitignore:39`), it is machine-generated, and it is never meant
to be formatted or read by a human.

The formatter's directory walker does not consult `.gitignore`, so any tree
where a test run has been interrupted — or is running right now — reports a
false formatting failure. It bit a local gate script whose first step is
`yo fmt --check ./tests`; the "failure" was a leftover from a run killed twenty
minutes earlier.

CI does not see it because it formats before it tests, so this is a local-only
papercut — which is exactly the kind that wastes a debugging cycle, because the
named file does not exist in `git status`.

## Two candidate fixes

1. **Honour `.gitignore` in the walker** (`src/formatter.yo`). Matches what a
   user expects of a whole-directory command and fixes it for every generated
   `.yo` file, not just this one. Needs a gitignore matcher, which the tree
   does not have yet.
2. **Skip dotfiles.** Every one of these starts with `.`, and a `.yo` file
   whose name begins with a dot is already invisible to `yo test` and `yo
   build`. One line, no new machinery, and it also covers editor scratch.

(2) is the proportionate fix; (1) is the complete one. Either way the walker
should be the place, not each caller.

## Not the same as

`issues/fixed/...` entries about the batch files COLLIDING between two
concurrent runs in one worktree — that is a different failure (spurious clang
"no such file") and is about running two suites at once, not about formatting.
