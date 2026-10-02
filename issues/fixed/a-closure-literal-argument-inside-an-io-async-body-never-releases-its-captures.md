# A closure literal passed as an argument inside an `io.async` body never releases its captures

**Severity:** S2. Each such call leaks one reference to every RC value the closure captures. A channel captured this way is never freed.

**Status: FIXED (2026-10-01).** Found by `tests/async_await.test.yo`'s "an Impl(Fn) parameter captured inside a no-await io.async block" under leak verdicts. The v0.2.46 seed leaks the same 88 B.

## Symptom

```rust
io.async((io : Io) => {
  chan := SyncChannel(i32).new(usize(1));
  sink := chan;
  _if_run_it(() => { sink.send(i32(5)); () });
  ...
})
```

Valgrind: `340 (88 direct, 252 indirect) bytes in 1 blocks are definitely lost`, the channel.

The same body in a plain function is clean. That case was fixed by #967: `tests/closure.test.yo`, "a closure literal passed as an argument releases its captures".

## Cause

A closure value owns its capture struct, whose fields hold dup'd references. The evaluator gives it an owning temp, whose scope-end drop releases them (`attach_temp_variable_to_expr` at the end of `evaluate_anonymous_function_implementation`).

That is skipped for the closure passed to `io.async`, whose captures the state machine owns, and it is keyed on `ctx.is_inside_io_async_call`. `create_function_body_evaluation_context` (`src/evaluator/context.yo`) copied the flag into the body's context. So every closure built inside an `io.async` body was treated as the `io.async` argument, got no owning temp, and its capture struct was never dropped.

## Fix

A function or closure body's context starts with `is_inside_io_async_call : false`. The flag's readers all ask about the closure literal being built as the call's argument, and code inside that closure's body is not it.

Test in `tests/async/sm_ownership.test.yo`: "a closure literal passed as an argument inside a task releases its captures" (a no-await body and an awaiting one).
