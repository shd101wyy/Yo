# The warnings stash test leaks under leak verdicts

**Severity:** S3: a test-only leak verdict. The compiler's warning stash (`emit_warning` / `take_warnings`, `src/diagnostics.yo`) leaves an allocation live at exit after a dedupe/take cycle. It keeps `tests/internal/error.test.yo` red with leak verdicts on. Whether it grows per compile has not been measured.

**Found:** 2026-10-16, during the Tier 1 gate of `fix/downcast-receiver-leak`. `tests/internal/error.test.yo` "warnings: the stash dedupes, takes clean, and honors the enabled flag" fails with `Memory leak detected:`, and the other 34 tests pass. The failure is identical on develop `982b4a685`, built from the tree, and the test uses no `downcast`.

## Reproducer

`yo test ./tests/internal/error.test.yo --parallel 1 --std-path ./std -v`

## Root cause

Not traced yet. The stash is a module-level `ArrayList(Diagnostic)`. `take_warnings` moves it out with `out := g_pending_warnings` and then reassigns the global to a fresh list, so the reference balance of a GLOBAL moved out and reassigned is the first suspect. The second is `emit_warning`'s `push(d)` of a borrowed `&Diagnostic`.

## Fix

TBD. The regression test is the existing test with leak verdicts on.
