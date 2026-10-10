# The E0901 note said a by-value parameter borrows

**Severity:** S3 — a use-of-moved-value note told the user the opposite of the parameter rule

> Found 2026-10-10 while rewording the `inout` messages for V3b Generation B
> step 3 (`plans/VALUES_BY_DEFAULT.md`). **FIXED same branch**
> (feat/vbd-v3b-addr-of-delete-inout).

## Symptom

The note under a move-only or explicit-copy E0901
(`_explicit_copy_hint`, `src/evaluator/utils.yo`) ended:

```text
`t` is copied explicitly: write `t.clone()` for a copy, move it (`sink(t)`), or pass it `inout`. A by-value parameter borrows it without a copy.
```

Since the flip (V3b Generation B step 2) a plain, by-value parameter OWNS its
argument: passing `t` to one moves it. The sentence predates the flip, when a
plain parameter borrowed.

## Fix

The note names the borrowing mode and the marker: "An `imm` parameter borrows
it without a copy (the call lends it with `&t`)." (`pass it `inout`` became
`lend it `mut``, with the rest of the `inout` wording.)

## Verification

`tests/move_only.test.yo` ("the E0901 note names why the type is move-only")
expects the new sentence; it failed before the change.
