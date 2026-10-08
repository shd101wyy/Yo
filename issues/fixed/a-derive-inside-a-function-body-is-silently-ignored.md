# A `derive` inside a function body is silently ignored

**Severity:** S2: a valid program is rejected with a misleading error, and a derive the user wrote has no effect and no diagnostic. A function-local type cannot get `Clone`, `Eq`, `Copy` or any other derived impl.

> Found 2026-10-08 while sweeping `derive(T, Copy, Clone)` for `plans/VALUES_BY_DEFAULT.md` decision 36 Generation B (#1269). The v0.2.54 seed behaves the same.

## Reproducer

```rust
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  P1 :: struct(x : i32, y : i32);
  derive(P1, Eq(P1), Clone);
  a := P1(x : i32(1), y : i32(2));
  b := a.clone();
  println((a == b).to_string());
});
export(main);
```

```
error[E0610]: No method "clone" on P1: the type has no field or method with that name.
```

The same `derive` at module level works. `comptime_assert(Type.impls(P1, Clone), ...)`
after the local derive fails too, so the impl is never registered.

## Root cause

`evaluate_derive` (`src/evaluator/builtins/derive.yo`) returns before doing
anything when `ctx.is_validating_function_definition || !ctx.is_executing`.
A runtime function body is evaluated with `is_executing` false, so a `derive`
in it is never reached. A local type declaration (`P1 :: struct(...)`) is
compile-time and works in the same body; its `derive` does not.

## Why it matters now

Decision 36's flip makes every named type that is not `Copy` copy explicitly.
A function-local plain-data type then cannot opt into `Copy`, so its copies
become moves (E0901) with no fix. `tests/basic.test.yo` (`Point1`, `Color`),
`tests/prelude.test.yo` (`EvenNumber`), `tests/match_structs.test.yo` (`Cell`)
and `tests/match_tuples.test.yo` (`Inner`) copy function-local types today.

## Fix direction

Run a function-body `derive` once, at the body's definition-time evaluation,
like the local type declaration it follows: register the impls against the
local type, and skip it on later re-evaluations of the same body (call-time
specializations, trial re-runs) so the impls are not registered twice
(E0612). The test lands with the fix: the reproducer above, plus a
function-local `derive(T, Copy, Clone)` whose value is copied twice.

## Fix (2026-10-08)

`evaluate_derive` (`src/evaluator/builtins/derive.yo`) no longer returns early
outside an executing context. In a function body it runs with the flags a macro
expansion uses (`is_executing` on, `is_validating_function_definition` and
`is_analyzing_ctfe_capability` off), so the derive rule's comptime fold
executes, under its own error handler (`_evaluate_derive_guarded`), so the flags
are restored before an error propagates to the caller's handler. The generated
impls are registered by site, so a body evaluated again (a trial, each
specialization of a generic function) registers them once.

## Verification

`tests/derive.test.yo`, "Derives inside a function body": a local
`derive(T, Eq(T), Clone)` used at run time; a local `derive(T, Copy, Clone)`
whose copy is independent; a generic function with a local derive specialized
at two types; `comptime_expect_error` of a local `derive(T, Copy)` and of a
local derive over a `String` field. The file fails on the v0.2.54 seed (63
failed) and passes with the fix (63 passed).
