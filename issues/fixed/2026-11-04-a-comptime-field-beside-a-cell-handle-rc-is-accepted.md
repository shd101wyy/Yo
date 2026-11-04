# A `comptime_int` field beside a cell-handle `Rc`/`Arc` is accepted

**Severity:** S3: a static rule gap that never reached develop. A struct or enum that mixes a comptime-only field (`comptime_int`) with an `Rc`/`Arc` field can exist in no evaluation context. It was accepted instead of being rejected, so the program failed later or the definition stayed unusable. No wrong code was emitted.

**Status:** FIXED 2026-11-04 by V5 cells Generation B (branch `vbd/v5-cells-gen-b`). The regression was introduced on that branch and found by its Tier 1 (`tests/basic.test.yo`, the "incompatible field contexts" arm).

## Symptom

```yo
main :: (fn() -> unit)({
  comptime_expect_error(Point3 :: struct(x : comptime_int, y : Rc(i32)));
  comptime_expect_error(PointArc :: struct(x : comptime_int, y : Arc(i32)));
  ()
});
export(main);
```

With the retyped prelude, `yo check` reports `Expected compile error, but the expression was evaluated successfully` for both lines. On develop before the retype, both definitions fail with `Type … has incompatible field contexts and cannot be used in any evaluation context.`

## Root cause

`fields_have_incompatible_contexts` (`src/types/utils.yo`) treats a field as runtime-only when it is a reference-semantics struct (`ref(struct(...))`). Before cells Generation B, `Rc(V)` was `ref(struct((*) : V))` and `Arc(V)` was its atomic twin, so both matched. Generation B makes them value newtypes over a cell primitive (`newtype(_cell : __yo_cell(V))`). The scan then fell through to the generic skip, because the instance still carries the declaration's SomeTs, and decided nothing.

## Fix

A counted handle (`is_counted_handle_value_type`: `Rc`, `Arc` or any cell-handle view) is runtime-only, like a `ref` object. The check runs before the generic skip, as the `ref` check does.

## Test

`tests/basic.test.yo`, "Test type availability", the `Point3` row (an `Rc` field), plus a new `PointArc` row (an `Arc` field). Both fail before the fix and pass after it.
