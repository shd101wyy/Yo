# The warnings stash test leaks under leak verdicts

**Severity:** S3: a test-only leak verdict. The compiler's warning stash (`emit_warning` / `take_warnings`, `src/diagnostics.yo`) leaves an allocation live at exit after a dedupe/take cycle. It keeps `tests/internal/error.test.yo` red with leak verdicts on. Whether it grows per compile has not been measured.

**Found:** 2026-10-16, during the Tier 1 gate of `fix/downcast-receiver-leak`. `tests/internal/error.test.yo` "warnings: the stash dedupes, takes clean, and honors the enabled flag" fails with `Memory leak detected:`, and the other 34 tests pass. The failure is identical on develop `982b4a685`, built from the tree, and the test uses no `downcast`.

## Reproducer

`yo test ./tests/internal/error.test.yo --parallel 1 --std-path ./std -v`

## Root cause

Traced 2026-10-18, in the emitted C of `emit_warning`. Both original suspects
were clean: `take_warnings`'s global reassignment is reference-balanced, and
`push(d)` dup's the borrowed diagnostic's fields correctly. The leak was the
DEDUPE loop's early `return`:

```c
if (__yo_sc_emit_warning_r6c112_n0) {
  return;                       // no "Drop local variables before early return"
}
```

That `return` — from inside the `match` arm's `&&`-chain, inside the loop —
ran WITHOUT the epilogue that every other early return in the same function
carries, so the loop body's `g_pending_warnings.get(pi)` temp was never
dropped. `get` hands out a field-dup'd copy of the stored `Diagnostic`, so one
dedupe-rejected `emit_warning` leaked `+1` references on the STORED warning's
message and path Strings (the report's 2×40 B directs with the 19-byte
"unused variable `a`" buffer and the 4-byte "t.yo" buffer as indirects). The
leak only surfaced once the stash was taken (`take_warnings` reassigns the
global, and the caller drops the taken list): with the stash still held, the
global's references kept the cells reachable and LSan stayed quiet — which is
why the shape needs the dedupe AND the take together.

A minimal standalone reproduction (the same loop/condition shape in a fresh
module) did NOT reproduce: the same early `return` there carried the drop
epilogue. What exactly makes THIS function's `return` lose its pending-drop
list is still open — the codegen gap is real but its trigger is narrower than
the shape (possibly the deferred-drop list state at that point in this
module's evaluation). The std-side fix below removes the shape entirely, and
the codegen gap should be re-probed when the deferred-drop list machinery is
touched next.

## Fix

`src/diagnostics.yo`'s `emit_warning` no longer returns from inside the loop
arm: a `seen` flag exits the loop through its condition, and the push happens
after the loop under `if(!seen, ...)`. Every iteration's `get` temp is then
dropped by the loop's own bottom-of-body drop, which the condition exit
always reaches.

Measured: `tests/internal/error.test.yo` 35/35 with leak verdicts ON (the
failing test was the stash one) and in CI mode. The file joins the
`leak-verdict.yml` allowlist so the weekly leg keeps the verdict on it; there
is no in-language oracle for a leaked reference count on an internal stash.

Fixed by PR (fix/warnings-stash-dedupe-leak).
