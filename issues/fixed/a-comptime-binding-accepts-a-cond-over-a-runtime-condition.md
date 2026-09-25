# A `::` binding accepts a `cond` (or `if`) whose condition is a runtime value

**Found:** 2026-09-25, re-measuring finding #11 of
`issues/type-error-diagnostics-point-into-std-and-use-inconsistent-codes.md` during
`plans/TYPE_SYSTEM_SOUNDNESS.md` Phase 4.4. **Severity:** HIGH (`check` passes, and the
program is either rejected by the C compiler or aborts at runtime).
**Status:** FIXED on `tss/phase4-4`.

## Reproducer

```rust
{ println } :: import("std/fmt");
g :: (fn(b : bool) -> unit)({
  N :: if(b, i32(1), i32(2));
  println(N.to_string());
});
main :: (fn() -> unit)(g(true));
export(main);
```

`yo check` passed. `yo compile` failed in the C compiler:

```
error: use of undeclared identifier 'N'
```

With `Type` arms (`T :: cond(b => i32, true => i64); x := T(5);`), `check` passed and
`g`'s body was emitted as a "failed to transpile" stub that aborts when called:

```
yo: FATAL: reached yo_id_…, whose body failed to transpile …
```

`YO_DEBUG_SWALLOW=1` printed nothing, because the evaluator never threw anything. The
same program written with `match(x, 1 => i32(10), _ => i32(20))` was already rejected
("Expected compile-time value for "N"").

## Root cause

`evaluate_cond` (`src/evaluator/exprs/cond.yo`) gave its result a value in two ways. If
some arm had no compile-time value, the result was a runtime value (`None`). Otherwise
the result was `create_unknown_val(ty)`, a compile-time *unknown*. The conditions were
never consulted. A runtime condition (a runtime parameter binds with no value, see
`_build_def_time_body_env`) therefore produced an `UnknownVal` whenever every arm was a
constant.

The `::` gate in `initialization_assignment.yo` rejects a missing value and a
runtime-only unknown, but accepts a plain `UnknownVal`: that is what a `comptime`
parameter looks like in a definition-time trial. So the binding was accepted as a
compile-time constant that nothing could ever evaluate. The retired TypeScript
compiler had the same rule (`caseBodyValues.some(undefined)` only).

## Fix

- `evaluate_cond` records the first considered condition that has no compile-time value
  (or is a runtime-only unknown), and the result of such a `cond` is a runtime value.
- A condition that is a compile-time unknown (a `comptime` parameter) keeps the result a
  compile-time unknown, as before. A function returning a compile-time value must declare
  every parameter `comptime`, so this distinction is exact.
- A runtime condition that selects a compile-time-only value (a `Type`, a module, a trait)
  is rejected at the condition:

```
error: This condition is only known at runtime, but the `cond` selects a compile-time-only
value of type Type. …
```

## Tests

- `tests/cli-cases/comptime-binding-of-a-runtime-if-is-an-error`
- `tests/cli-cases/type-cond-on-a-runtime-condition-is-an-error`
