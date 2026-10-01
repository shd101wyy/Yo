# `Stream.for_each` leaks 48 bytes per call (state object + inner slot)

**Severity:** S2 — every `Stream ... .for_each(...)` use leaks a 32-byte object plus a 16-byte inner allocation; a long-running consumer loop grows without bound

**Found**: 2026-10-01, running the local fast suite for the safe-mode audit PR — `yo test ./tests --exclude tests/internal --exclude tests/cli-cases` with leak verdicts ON (their default outside CI) fails `tests/async/combinators.test.yo`. **Status**: OPEN. Reproduces with the installed v0.2.48 seed binary, so it predates 2026-10-01's async merges; CI has never seen it because every CI job sets `YO_TEST_LEAK_VERDICT=0` (`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md` — the hollow-gate issue).

## Symptom

```
$ yo test tests/async/combinators.test.yo --test-name-pattern "Stream for_each" --parallel 1 -v
  ✗ Test Stream for_each from main
    Memory leak detected:
    Direct leak of 32 byte(s) in 1 object(s) allocated from: [...]
    Indirect leak of 16 byte(s) in 1 object(s) allocated from: [...]
    SUMMARY: AddressSanitizer: 48 byte(s) leaked in 2 allocation(s).
  ✗ Test Stream for_each inside a spawned task
    [same shape]
```

Two failures in the file, both `for_each`; the rest of the file's 30+ Stream
combinator tests (map / filter / take / skip / chains, inside spawned tasks
too) are leak-clean, which points at `for_each`'s own lowering rather than the
shared combinator plumbing. The direct/indirect pair (32 + 16) reads like a
Stream state object holding an inner closure/slot that is never released.

## Reproducer

The command above, with either the installed seed or a tree-built `yo`.
Keep `YO_TEST_LEAK_VERDICT` unset locally — CI's `=0` makes the same run pass
vacuously.

## Root cause

Not yet traced. Adjacent open work owns the area: #1093 (task-slot ownership
leaks, step 2) and #1073 (await-site fusion) both touch the same async
state-machine pool; the leak may be a shape neither has reached. Filing so the
next async pass has the exact allocation sizes and the failing tests by name.

## Fix

TBD with the root cause; the regression gate is the two tests above running
with leak verdicts on — the very configuration CI currently disables.
