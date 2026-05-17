# yo-self-bin segfaults after rebuilding with current src/codegen

## Status

Open. Discovered while running `./yo-cli compile yo-self/main.yo --release`
during May 15 session.

## Symptom

The yo-self bootstrap binary, when rebuilt today from current `src/codegen`,
segfaults (exit 139) or produces no output on any non-trivial test input.

```
$ ./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-bin-new
$ /tmp/yo-self-bin-new test tests/basic.test.yo
$ echo $?
139
```

The same source rebuilt at origin/bootstrap/phase-4 also segfaults — this
is _not_ caused by the 8 unpushed bootstrap refactor commits in
`bootstrap/phase-4`.

The previous `yo-self/yo-self-bin` binary built on May 14 worked correctly
(it ran the per-test-file passes shown in
`/private/tmp/.../bybo02h91.output`: 354 pass / 107 fail / 599 skip across
the full test suite).

## Hypothesis

Two `src/codegen` commits landed on May 14 ~27h before the binary stopped
working:

- `d62ff8b2 codegen: don't emit caller-scope consumed-var drops in ctl
handler bodies`
- `a75007f9 codegen: keep base function emitted when no specialized
replacement is registered`

Both claim to fix Stream A blockers documented under `issues/`. One or
both likely introduced a behaviour change in the generated C that the
yo-self runtime cannot survive (e.g. an undeclared temp, a missing
forward decl, or a use-after-free).

## Repro

```
git checkout origin/bootstrap/phase-4
./yo-cli compile yo-self/main.yo --release -o /tmp/yo-self-test
/tmp/yo-self-test test tests/basic.test.yo
# observed: empty output, exit 139 (SIGSEGV) on some inputs, exit 0
# with empty output on others
```

## Bisect candidates

1. `git checkout d62ff8b2~1` then rebuild — does the binary work? If yes,
   the regression is in d62ff8b2 (ctl-handler-body drop).
2. Otherwise `git checkout a75007f9~1` — narrows to the
   base-unspecialized-emit change.

Each rebuild is ~7 minutes on M1, so a full bisect is ~30 minutes.

## Investigation in May 15 session

Reverting just the two src/codegen commits (keeping current yo-self/)
_doesn't_ unblock the build — instead clang fails with missing forward
declarations:

```
fn_yodb87f9d4_id_525_parse: implicit declaration
fn_yo70489165_id_10__evaluate_expression: implicit declaration
```

Suggests the current `yo-self/main.yo` _depends_ on the new behaviour
introduced by d62ff8b2 / a75007f9 (specifically the change that
"keep base function emitted when no specialized replacement is
registered"). With the old codegen, those base functions are elided
and the call sites that reference them produce implicit-declaration
errors.

Likewise, attempting `git checkout 41535d46` (the previous-working
state from May 14 13:02) drops back to a different yo-self/ directory
layout (`yo-self/expr/expr.yo` vs current `yo-self/expr.yo`,
`yo-self/codegen/types.yo` vs current `yo-self/codegen/types/generation.yo`,
…). So the May 14 binary was built against substantially different
yo-self/ sources — restoring "the working state" isn't a clean
revert.

Conclusion: this is _not_ a simple regression to fix by reverting one
commit. The May 14 src/codegen change moved the goal posts; yo-self
needs to evolve to match the new behaviour. The realistic fix path:

1. Identify which yo-self call site produces an undeclared-function
   reference in the _current_ generated C output. The yo-self
   bootstrap dispatcher (`yo-self/codegen/exprs.yo`) likely needs to
   emit a forward declaration that the new TS codegen relies on.
2. OR adjust `yo-self/codegen/driver.yo`'s hoisting / forward-decl
   pass to cover the additional cases.

That's a non-trivial debug session against the 250K-line generated C
output.

## Impact

Blocks the Stream A integration loop documented in BOOTSTRAPPING.md
Path forward: the only way to validate yo-self changes today is via
the per-handler unit tests in `yo-self/tests/codegen_exprs_*.test.yo`
(which all pass — 48 in codegen_exprs.test.yo, plus per-handler suites
green). The actual yo-self end-to-end pipeline (`yo-self-bin test
tests/X.test.yo`) cannot be exercised until this regression is fixed.

## Pinned work that's blocked

In the May 15 session, an `exprs.yo` fix for the match
.Some/.None dispatch bug (commit `efe2bef1`) is logically correct but
cannot be runtime-verified against `tests/higher_kinded_types.test.yo`
until yo-self-bin builds successfully. The TS compiler test confirms
the test in question passes there; the yo-self version was failing
because `handle_match_data`'s `simplified_some_body` path was emitting
only the `.Some` arm body and ignoring `.None`. The fix pre-scans for
`.None`/`.Err`/`_` arms and disables the simplification when any are
present, falling through to `emit_option_null_if_else` for proper
dispatch.

When the build is unblocked, expect these three tests in
`tests/higher_kinded_types.test.yo` to flip from fail to pass:

- `Functor map on Option None`
- `do_map on None preserves None`
- `Mappable transform on None`
