# `yo test` warns about its own `io` binding

**Severity:** S3: cosmetic noise. Every test batch whose tests never name `io` printed `warning: unused variable \`io\`` for a binding the runner itself generates, burying real warnings in every CI test log.

## Symptom

```
warning: unused variable `io`
 --> tests/.yo_selftest_batch_…yo:9:3
  |
9 |   io :: __yo_builtin_io;
  |   ^^
help: prefix the name with `_` to silence this warning
```

## Root cause

`run_test` (`src/main.yo`) synthesizes each batch's `main` with
`io :: __yo_builtin_io;` so a test body can use `io`. A body may also reach it
without naming it (an implicit `using(io : Io)` parameter resolves it from
scope), so the binding cannot be emitted only when the text names `io`, and
renaming it `_io` would break every body that does name it. The compile-time
`io :: __yo_builtin_io` shape is load-bearing for async bodies
(`src/evaluator/calls/function.yo`), so moving `io` into `main`'s signature
would change their codegen path.

## Fix

The runner also emits `_yo_batch_io :: io;`: a use of `io` whose own name is
exempt from the lint. Test: the CLI case
`test-batch-does-not-warn-about-its-io-binding` keeps any unused-variable
warning in its golden; it fails before the fix.
