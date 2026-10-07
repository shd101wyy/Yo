# comptime_expect_error(derive(...)) in a function body never sees the error

**Severity:** S3 — a test written as `comptime_expect_error(derive(X, Trait), "...")` inside a `test(...)` body fails the whole batch with a confusing "the expression raised an error, but not the expected one"-shaped message (the no-error path echoes the expected text), because the derive never ran; nothing is silently accepted.

Found 2026-10-06 while fixing the `feat/vbd-copy-trait` review findings: `tests/copy_trait.test.yo`'s "derive(T, Copy) alone is an error" case, written inside its `test(...)` body, failed the batch.

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
