# A local fast suite with leak verdicts on fails 28 async tests CI cannot see

(Originally filed as "`Stream.for_each` leaks 48 bytes per call"; the 2026-10-02
re-measure below found the whole family.)

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

## The family (re-measured 2026-10-02)

A full `yo test ./tests --exclude tests/internal --exclude tests/cli-cases`
with leak verdicts on (no `--bail`) reports **28 failures, every one of them
"Memory leak detected"** — zero compile or wrong-result failures — across
`tests/async_await.test.yo` (the async while-loop break/continue
Box-drop tests, the early-return-across-await test, effect-row-spread
futures, unwind-in-async-closure), `tests/async/*.test.yo` (Stream
`for_each` both forms, the raw-future JoinHandle, the waker-ordering
resume test, match-arm spawn shapes), the dyn downcast/upcast tests, and
`array_list nested literals` / `fold with RC accumulator does not leak`.
Every one reproduces with the INSTALLED v0.2.48 seed binary on the same
test files — none are caused by the tree's own diffs. The two constants:
every failure is a LeakSanitizer verdict, and CI never sees any of them
(`YO_TEST_LEAK_VERDICT=0` in every job).

**Also local-only, and predating v0.2.48** (found while gating the safe-mode
PRs on develop `7d04eb24d`, 2026-10-02):
`tests/async_while_in_match_arm.test.yo`'s "a spawn of an inline io.async
block survives in a match arm with an awaiting while" reports
`Memory leak detected`. It fails the same way on clean develop and was already
failing in a v0.2.47 leak-verdict-on baseline (tree std at `74fe87715`,
2026-10-01). `tests/basic.test.yo`'s "a tuple element type inside a generic
container declares its C name in time" is the other leak verdict in that run.
It has its own doc:
`issues/a-container-stored-in-a-tuple-stored-in-a-container-is-never-released.md`.

## Root cause

Not yet traced. Adjacent open work owns the area: #1093 (task-slot ownership
leaks, step 2) and #1073 (await-site fusion) both touch the same async
state-machine pool; the leak may be a shape neither has reached. Filing so the
next async pass has the exact allocation sizes and the failing tests by name.

## Fix

TBD with the root cause; the regression gate is the two tests above running
with leak verdicts on — the very configuration CI currently disables.
