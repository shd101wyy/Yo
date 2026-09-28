# A String captured by a nested `io.async` inside a state machine is dropped but never retained (heap-use-after-free)

**Severity:** S1 — a String captured by a nested io.async is freed while the outer state machine still holds it — verified heap-use-after-free read at resume

**Status: FIXED (2026-09-29).** Found 2026-09-28 by the async state-machine audit (`plans/ASYNC_STATE_MACHINE_GENERATION.md`). Reproduces on the v0.2.45 seed and on a tree build of develop `af62bdb28`.

## Symptom

`issues/repros/nested-io-async-string-capture-is-not-retained.yo`: an outer
`io.async` holds `s : String` and `t : Thing` across an await, then awaits
an inner `io.async` that reads both.

```
ERROR: AddressSanitizer: heap-use-after-free READ of size 8
    #0 in <String.len>
    #2 in <outer>_resume
freed by: __yo_decr_rc <- <inner>_state_dispose <- __yo_dispose_dispatch <- <outer>_resume
```

## Root cause

The inner future's capture literal is built by
`_build_async_capture_struct_literal` (`src/codegen/exprs/async.yo`) from
the outer machine's fields:

```c
__yo_cap_… = {.s = sm->var_s, .t = sm->var_t, …};
if (__yo_cap_….t != NULL) __yo_incr_rc(t);      // .t retained, .s not
```

`_rc_field_retain_line` returns `.None` for String and Option (the same
missing fallback as `_rc_field_drop_line`, see
`issues/fixed/abort-dispose-never-drops-string-option-and-value-struct-locals.md`),
while the inner machine's dispose drops `sm->__capture.s`. The outer
machine's `s` is then freed under it.

## Fix direction

Give `_rc_field_retain_line` the `generate_dup_code_for_value` fallback,
keeping it an exact mirror of the drop helper. A unit test pins the pair
over a type matrix (String, Option(String), a value struct with a String
field, an enum with an RC payload): retain and drop must both be emitted,
or neither.

## Fix (2026-09-29)

Fixed by the same `_inline_rc_field_line` fallback: `_rc_field_retain_line` now retains a String or Option capture field, the mirror of the drop the inner future's dispose performs. Regression: `tests/async/sm_ownership.test.yo`, "a nested io.async capturing a state machine's String retains it" (ASan UAF before).
