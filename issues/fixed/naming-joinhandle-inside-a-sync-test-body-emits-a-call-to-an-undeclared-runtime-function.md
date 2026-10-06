# Naming `JoinHandle(T)` inside a sync test body emits a call to an undeclared runtime function

**Severity:** S2 — a valid program that only names `JoinHandle(i32)` (here in a `Type.impls`
query) failed at the C compiler, with no Yo diagnostic

**Status:** FIXED 2026-10-06 (feat/vbd-send-sync). A call to a `__yo_join_*` runtime extern
marks the program `uses_async`, exactly like the `__yo_waker_*` family before it, so the async
runtime — which defines those helpers — is emitted.

## Symptom

`issues/repros/join-handle-named-in-a-sync-test-body.test.yo`:

```rust
test("jh", {
  comptime_assert(!Type.impls(JoinHandle(i32), Sync), "JoinHandle is not Sync");
});
```

`yo test` on it failed in clang:

```
error: call to undeclared function '__yo_join_handle_release_raw'; ISO C99 and later do not
support implicit function declarations [-Wimplicit-function-declaration]
  __yo_join_handle_release_raw(((void*)(__yo_v_self->__future)));
```

The same query with `Send` failed the same way. At module level (as in
`tests/thread_safety.test.yo`) it compiled.

## Root cause

Naming the type inside a function body instantiates `JoinHandle(i32)` and emits its `Dispose`
body, which calls `__yo_join_handle_release_raw` (the prelude's `Dispose` impl hands the handle's
future reference to the runtime helper). That helper is defined only with the async runtime
(`src/codegen/async/runtime_core.yo`), which a program with no `io.async` does not emit — and
`is_async_runtime_extern_name` (`src/codegen/exprs/async.yo`) did not know the `__yo_join_`
family belongs to that runtime, so the call did not set `uses_async`. The same latent gap covers
the `__yo_join_wait_*` family behind `std/async`'s combinators.

## Fix

`is_async_runtime_extern_name` accepts the `__yo_join_` prefix, mirroring the `__yo_waker_`
precedent (`issues/fixed/a-waker-in-a-program-without-await-calls-an-undeclared-runtime-function.md`):
any call into the join helpers — the Dispose body a mere type naming emits, or a std/async
combinator — pulls the runtime in, and the definition is there.

## Verification

- `tests/send_sync.test.yo`'s "Io and JoinHandle declare negative markers" is back INSIDE a
  test body (it had been moved to module level as a workaround); it names `JoinHandle(i32)`
  and compiles.
- `issues/repros/join-handle-named-in-a-sync-test-body.test.yo` passes.
