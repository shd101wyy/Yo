# On abort or unwind, a state machine never drops its String / Option / value-struct cross-boundary locals (leak)

**Severity:** S1 — every abort/unwind of a task holding String/Option/value-struct locals leaks them — unbounded leak in generated code

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/abort-dispose-skips-string-option-locals.yo`: a task holds
`String.from(...)`, an interpolated String, an `ArrayList` and an
`Option(String)` across a `yield`, and is aborted.

```
abort: none=true
LEAK Direct 32 B x 1 : __yo_rc_alloc <- __yo_new_<String buffer> …   (x5)
```

`issues/repros/abort-unwind-leaks-string-ctl-arg.yo` is the same for an
effect unwind: the String passed to a ctl that unwinds inside `io.async`
leaks, and the synchronous version does not. In real code,
`race_first`/`any_first` losers leak their String locals.

Pointer-typed locals (`ArrayList`, `ref` structs) are dropped correctly, so
dispose counters for `ref` types look right while every String leaks. This
is also why `issues/async-abort-dispose-double-drops-moved-enum-payload.md`
now shows a leak rather than a double drop.

## Root cause

`generate_async_block_state_dispose_function`
(`src/codegen/exprs/async.yo`) builds its `state == -2` drop list with
`_rc_field_drop_line`. For a type that CONTAINS RC fields but is not
itself a pointer (String, Option(String), value structs, enums), that
helper consults `get_drop_function_for_type`, and returns `.None` when
there is none. That is the ordinary case, since no `___drop` helpers are
synthesized. The capture-drop path has a fallback
(`_emit_inline_capture_field_drops` → `generate_drop_code_for_value`); the
local-slot path does not.

## Fix direction

Give `_rc_field_drop_line` (and its mirror `_rc_field_retain_line`, see
`issues/fixed/nested-io-async-string-capture-is-not-retained.md`) the
`generate_drop_code_for_value` / `generate_dup_code_for_value` fallback.
The structural fix is plan phase 4: per-state live sets, so dispose drops
exactly the slots live in the state the task died in. Today it drops every
cross-boundary local, relying on NULL-initialised memory and on moves
having NULLed their source.

## Fix (2026-09-29)

`_rc_field_drop_line` and `_rc_field_retain_line` (`src/codegen/exprs/async.yo`) fall back to a new `_inline_rc_field_line`. It runs `generate_drop_code_for_value` / `generate_dup_code_for_value` against a scratch emitter and returns every line they produced, so a String, an Option, a value struct or an enum with an RC payload is dropped on abort. Regression: `tests/async/sm_ownership.test.yo`, "an aborted task drops its Option and value-struct locals". The two repros are LeakSanitizer-clean with a stage-1 build; `abort-unwind-leaks-string-ctl-arg.yo` has only the 64 B abort-registry array left, which is `thread-local-async-registries-leak-at-thread-exit`.
