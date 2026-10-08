# comptime_expect_error(derive(...)) in a function body never sees the error

**Severity:** S3 — a test written as `comptime_expect_error(derive(X, Trait), "...")` inside a `test(...)` body fails the whole batch with a confusing "the expression raised an error, but not the expected one"-shaped message (the no-error path echoes the expected text), because the derive never ran; nothing is silently accepted.

**FIXED 2026-10-08** (same fix as `issues/fixed/a-derive-inside-a-function-body-is-silently-ignored.md`). Found 2026-10-06 while fixing the `feat/vbd-copy-trait` review findings: `tests/copy_trait.test.yo`'s "derive(T, Copy) alone is an error" case, written inside its `test(...)` body, failed the batch.

## Symptom

```rust
_CtBare :: struct(n : i32);
main :: (fn() -> unit)({
  comptime_expect_error(derive(_CtBare, Copy), "derive(_CtBare, Copy, Clone)");
  ()
});
export(main);
```

```
error: "derive(_CtBare, Copy, Clone)"
  --> ./tmp/repro1.yo:3:3
```

That message is `evaluate_comptime_expect_error`'s no-error path re-throwing the expected text (`src/evaluator/builtins/comptime_expect_error.yo`, the `arg_threw == false` tail): the argument evaluated without error, so the expectation "succeeded" the wrong way.

## Root cause

`evaluate_derive` (`src/evaluator/builtins/derive.yo`) early-returns when
`ctx.is_validating_function_definition || !ctx.is_executing`: a derive's
impl registrations are module-level statements, and a def-time body trial must
not run them. A `comptime_expect_error` inside a function body evaluates its
argument exactly under that trial, so a derive argument is skipped and no
error is raised. `impl(...)` arguments are not gated this way, which is why
`comptime_expect_error(impl(X, Trait(...)), ...)` in a body works (the
existing tests in `tests/move_only.test.yo` and `tests/deref_auto.test.yo`).

## Workaround (what tests/copy_trait.test.yo does)

Pin derive rejections at MODULE level, where the module walk executes
statements for real:

```rust
_CtBare :: struct(n : i32);
comptime_expect_error(derive(_CtBare, Copy), "derive(_CtBare, Copy, Clone)");
```

`tests/comptime.test.yo` already uses module-level `comptime_expect_error`
for other builtins.

## Fix direction

Either let `evaluate_derive` run under `comptime_expect_error`'s propagate
mode (the builtin already sets `set_propagate_def_time_errors(true)` around
the argument), or make the no-error path's message name the skipped form
("a derive inside a function body is not evaluated; pin it at module
level") instead of echoing the expected text.

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
